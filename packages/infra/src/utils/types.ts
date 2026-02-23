export type DeepPartial<T> = T extends Function
  ? T
  : T extends Record<string, any>
    ? {
        [P in keyof T]?: DeepPartial<T[P]>
      }
    : T

export type TwoLevelPartial<T> = T extends Function
  ? T
  : T extends Record<string, any>
    ? {
        [P in keyof T]?: Partial<T[P]>
      }
    : T

export type Serializable<T> = T extends Function
  ? never
  : T extends Promise<infer U>
    ? Serializable<U>
    : T extends string & {}
      ? T
      : T extends Record<string, any>
        ? {
            [K in keyof T]: Serializable<T[K]>
          }
        : T

export type ValueOf<T> = T[keyof T]
