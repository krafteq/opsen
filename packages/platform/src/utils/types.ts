export type TwoLevelPartial<T> = T extends Function
  ? T
  : T extends Record<string, any>
    ? {
        [P in keyof T]?: Partial<T[P]>
      }
    : T

export type ValueOf<T> = T[keyof T]
