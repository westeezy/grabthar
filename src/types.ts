export type LoggerType = {
    readonly debug: (...args: Array<any>) => any;
    readonly info: (...args: Array<any>) => any;
    readonly warn: (...args: Array<any>) => any;
    readonly error: (...args: Array<any>) => any;
};
export type CacheType = {
    get: <T>(arg0: string) => Promise<T | void>;
    set: <T>(arg0: string, arg1: T) => Promise<T>;
};
