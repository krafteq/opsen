import * as pulumi from '@pulumi/pulumi'
import * as app from '@pulumi/azure-native/app'
import * as authorization from '@pulumi/azure-native/authorization'
import * as keyvault from '@pulumi/azure-native/keyvault'
import * as network from '@pulumi/azure-native/network'
import * as storage from '@pulumi/azure-native/storage'
import * as web from '@pulumi/azure-native/web'
import type { Workload } from '@opsen/platform'
import {
  AzureRuntime,
  AzureRuntimeDeployer,
  AzureWebAppRuntimeDeployer,
  buildContainerAppSpec,
  ContainerAppDeployer,
  buildWebAppSpec,
  WebAppDeployer,
} from '@opsen/azure'

const location = 'germanywestcentral'
const resourceGroupName = 'rg-dev'
const dnsZoneName = 'example.com'
const kvVaultUrl = 'https://AZURE_KEYVAULT_NAME_PLACEHOLDER.vault.azure.net/'
const subscriptionId = 'AZURE_SUBSCRIPTION_ID_PLACEHOLDER'

// ═══════════════════════════════════════════════════════════════════
// PREREQUISITES
// ═══════════════════════════════════════════════════════════════════

// Container Apps Managed Environment
const acaEnv = new app.ManagedEnvironment('e2e-aca-env', {
  environmentName: 'opsen-e2e-env',
  resourceGroupName,
  location,
})

// App Service Plan (Linux B1)
const appServicePlan = new web.AppServicePlan('e2e-asp', {
  name: 'opsen-e2e-asp',
  resourceGroupName,
  location,
  kind: 'Linux',
  reserved: true,
  sku: { name: 'B1', tier: 'Basic' },
})

// Storage Account + File Share (for persistent volume tests)
const storageAccount = new storage.StorageAccount('e2estore', {
  accountName: 'opsene2estore',
  resourceGroupName,
  location,
  kind: storage.Kind.StorageV2,
  sku: { name: storage.SkuName.Standard_LRS },
})

const fileShare = new storage.FileShare('e2e-share', {
  accountName: storageAccount.name,
  resourceGroupName,
  shareName: 'e2eshare',
})

const storageKeys = pulumi
  .all([storageAccount.name])
  .apply(([accountName]) => storage.listStorageAccountKeys({ accountName, resourceGroupName }))
const primaryStorageKey = storageKeys.keys[0].value

// Key Vault secret for WebApp KV reference test
const kvSecret = new keyvault.Secret('e2e-secret', {
  vaultName: 'AZURE_KEYVAULT_NAME_PLACEHOLDER',
  resourceGroupName,
  secretName: 'e2e-test-secret',
  properties: {
    value: 'hello-from-keyvault',
  },
})

// ═══════════════════════════════════════════════════════════════════
// TEST 1: ACA via RuntimeDeployer
// External ingress, health checks, scaling, files, EmptyDir volume
// ═══════════════════════════════════════════════════════════════════

const acaWorkload: Workload<AzureRuntime> = {
  image: 'nginx:alpine',
  env: {
    TEST_SCENARIO: 'aca-runtime-deployer',
  },
  processes: {
    web: {
      ports: {
        http: { port: 80, protocol: 'http' },
      },
      healthcheck: {
        liveness: {
          action: { type: 'http-get', httpGet: { path: '/', port: 80 } },
          periodSeconds: 10,
          failureThreshold: 3,
        },
        readiness: {
          action: { type: 'http-get', httpGet: { path: '/', port: 80 } },
          periodSeconds: 5,
        },
      },
      _az: {
        minReplicas: 1,
        maxReplicas: 2,
        cpu: 0.25,
        memory: 0.5,
      },
    },
  },
  endpoints: {
    public: {
      backend: { process: 'web', port: 'http' },
      ingress: {
        hosts: [], // external with auto FQDN, no custom domain
      },
    },
  },
  volumes: {
    cache: {
      path: '/tmp/cache',
      _az: { persistent: false },
    },
  },
  files: [
    {
      path: '/etc/opsen/test.txt',
      content: 'aca-runtime-deployer-ok',
    },
  ],
}

const acaDeployer = new AzureRuntimeDeployer({
  name: 'e2e-aca',
  environmentId: acaEnv.id,
  resourceGroupName,
  location,
})

const test1Result = acaDeployer.deploy(acaWorkload, { name: 'e2e-aca' })

// ═══════════════════════════════════════════════════════════════════
// TEST 2: ACA with custom domain via building blocks
// DNS TXT + CNAME records, custom domain binding (no TLS)
// ═══════════════════════════════════════════════════════════════════

const acaDomainVerificationId = acaEnv.customDomainConfiguration.apply((cfg) => cfg?.customDomainVerificationId ?? '')
const acaDefaultDomain = acaEnv.defaultDomain

// TXT record for ACA domain verification
const acaTxtRecord = new network.RecordSet('aca-domain-txt', {
  resourceGroupName,
  zoneName: dnsZoneName,
  relativeRecordSetName: 'asuid.aca',
  recordType: 'TXT',
  ttl: 300,
  txtRecords: [{ value: [acaDomainVerificationId] }],
})

// CNAME: aca.example.com → {app-name}.{env-default-domain}
const acaCnameRecord = new network.RecordSet('aca-domain-cname', {
  resourceGroupName,
  zoneName: dnsZoneName,
  relativeRecordSetName: 'aca',
  recordType: 'CNAME',
  ttl: 300,
  cnameRecord: {
    cname: pulumi.interpolate`e2e-aca-domain-web.${acaDefaultDomain}`,
  },
})

// Deploy container app with custom domain after DNS records exist
const test2Result = pulumi.all([acaTxtRecord.id, acaCnameRecord.id]).apply(() => {
  const wl = {
    image: 'nginx:alpine',
    env: { TEST_SCENARIO: 'aca-custom-domain' },
    processes: {
      web: {
        ports: { http: { port: 80, protocol: 'http' as const } },
        _az: { minReplicas: 1, maxReplicas: 1, cpu: 0.25, memory: 0.5 },
      },
    },
    endpoints: {
      public: {
        backend: { process: 'web', port: 'http' },
        ingress: {
          hosts: ['aca.example.com'],
        },
      },
    },
  }

  const spec = buildContainerAppSpec(wl as any, { name: 'e2e-aca-domain' }, 'web', wl.processes.web as any)

  const deployer = new ContainerAppDeployer({
    name: 'e2e-aca-domain',
    environmentId: acaEnv.id,
    resourceGroupName,
    location,
  })

  return deployer.deploy(spec)
})

// ═══════════════════════════════════════════════════════════════════
// TEST 3: WebApp via RuntimeDeployer — basic + health check
// ═══════════════════════════════════════════════════════════════════

const webappWorkload: Workload<AzureRuntime> = {
  image: 'nginx:alpine',
  env: {
    TEST_SCENARIO: 'webapp-runtime-deployer',
  },
  processes: {
    web: {
      ports: {
        http: { port: 80, protocol: 'http' },
      },
      healthcheck: {
        liveness: {
          action: { type: 'http-get', httpGet: { path: '/', port: 80 } },
          periodSeconds: 30,
        },
      },
    },
  },
  endpoints: {
    public: {
      backend: { process: 'web', port: 'http' },
    },
  },
}

const webappDeployer = new AzureWebAppRuntimeDeployer({
  appServicePlanId: appServicePlan.id,
  resourceGroupName,
  location,
  keyVault: { vaultUrl: kvVaultUrl },
})

const test3Result = webappDeployer.deploy(webappWorkload, { name: 'e2e-webapp' })

// ═══════════════════════════════════════════════════════════════════
// TEST 4: WebApp with custom domain + storage mount via building blocks
// Two-phase: create app → get verification ID → DNS → hostname binding
// ═══════════════════════════════════════════════════════════════════

const test4Result = pulumi
  .all([storageAccount.name, primaryStorageKey, fileShare.id])
  .apply(([storageName, storageKey]) => {
    const wl = {
      image: 'nginx:alpine',
      env: { TEST_SCENARIO: 'webapp-full' },
      processes: {
        web: {
          ports: { http: { port: 80, protocol: 'http' as const } },
          healthcheck: {
            liveness: {
              action: { type: 'http-get' as const, httpGet: { path: '/', port: 80 } },
            },
          },
          volumes: {
            data: {
              path: '/mnt/data',
              _az: { persistent: true },
            },
          },
        },
      },
      endpoints: {
        public: {
          backend: { process: 'web', port: 'http' },
          // NO hosts here — we handle custom domain binding separately
        },
      },
    }

    const spec = buildWebAppSpec(wl as any, { name: 'e2e-wafull' }, 'web', wl.processes.web as any, {
      kvVaultUrl,
      storageAccount: { name: storageName, key: storageKey, shareName: 'e2eshare' },
    })

    const deployer = new WebAppDeployer({
      name: 'e2e-wafull',
      appServicePlanId: appServicePlan.id,
      resourceGroupName,
      location,
      keyVault: { vaultUrl: kvVaultUrl },
      storageAccount: { name: storageName, key: storageKey, shareName: 'e2eshare' },
    })

    const deployed = deployer.deploy(spec)

    // Phase 2: custom domain binding using verification ID from the created app
    const verificationId = deployed.app.customDomainVerificationId.apply((v) => v ?? '')

    const txtRecord = new network.RecordSet('webapp-domain-txt', {
      resourceGroupName,
      zoneName: dnsZoneName,
      relativeRecordSetName: 'asuid.webapp',
      recordType: 'TXT',
      ttl: 300,
      txtRecords: [{ value: [verificationId] }],
    })

    const cnameRecord = new network.RecordSet('webapp-domain-cname', {
      resourceGroupName,
      zoneName: dnsZoneName,
      relativeRecordSetName: 'webapp',
      recordType: 'CNAME',
      ttl: 300,
      cnameRecord: { cname: deployed.defaultHostname },
    })

    new web.WebAppHostNameBinding(
      'e2e-wafull-web-webapp-az-krafteq-de',
      {
        name: deployed.app.name,
        resourceGroupName,
        hostName: 'webapp.example.com',
      },
      { dependsOn: [txtRecord, cnameRecord] },
    )

    return deployed
  })

// ═══════════════════════════════════════════════════════════════════
// TEST 5: WebApp with Key Vault secret reference
// ═══════════════════════════════════════════════════════════════════

const test5Result = pulumi.all([kvSecret.properties]).apply(() => {
  const spec = {
    name: 'e2e-wakv-web',
    image: 'nginx:alpine',
    appSettings: {
      TEST_SCENARIO: 'webapp-keyvault',
      SECRET_VALUE: `@Microsoft.KeyVault(SecretUri=${kvVaultUrl}secrets/e2e-test-secret/)`,
    },
    healthCheckPath: '/',
    port: 80,
    alwaysOn: true,
  }

  const deployer = new WebAppDeployer({
    name: 'e2e-wakv',
    appServicePlanId: appServicePlan.id,
    resourceGroupName,
    location,
    keyVault: { vaultUrl: kvVaultUrl },
  })

  const deployed = deployer.deploy(spec)

  // Grant the webapp's managed identity access to Key Vault
  deployed.app.identity.apply((identity) => {
    if (identity?.principalId) {
      new authorization.RoleAssignment('e2e-webapp-kv-role', {
        scope: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.KeyVault/vaults/AZURE_KEYVAULT_NAME_PLACEHOLDER`,
        principalId: identity.principalId,
        principalType: 'ServicePrincipal',
        roleDefinitionId: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6`,
      })
    }
  })

  return deployed
})

// ═══════════════════════════════════════════════════════════════════
// EXPORTS — URLs for verification
// ═══════════════════════════════════════════════════════════════════

// Test 1: ACA auto FQDN
export const test1_aca_url = test1Result.apply((r) => {
  const ep = r.endpoints?.public
  return ep ? `https://${ep.host}` : 'NO_ENDPOINT'
})

// Test 2: ACA custom domain
export const test2_aca_domain_fqdn = test2Result.apply((r) => r.fqdn)
export const test2_aca_domain_url = pulumi.interpolate`http://aca.${dnsZoneName}`

// Test 3: WebApp auto hostname
export const test3_webapp_url = test3Result.apply((r) => {
  const ep = r.endpoints?.public
  return ep ? `https://${ep.host}` : 'NO_ENDPOINT'
})

// Test 4: WebApp custom domain + storage
export const test4_webapp_domain_url = pulumi.interpolate`https://webapp.${dnsZoneName}`
export const test4_webapp_default = test4Result.apply((r) =>
  r.defaultHostname.apply((h: string) => (h ? `https://${h}` : 'NO_HOSTNAME')),
)

// Test 5: WebApp KV
export const test5_webapp_kv_url = test5Result.apply((r) =>
  r.defaultHostname.apply((h: string) => (h ? `https://${h}` : 'NO_HOSTNAME')),
)
