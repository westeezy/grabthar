export async function wrapPromise<T extends unknown>(
    handler: (
        reject: (reason: unknown | null | undefined) => void
    ) => Promise<T>
): Promise<T> {
    // eslint-disable-next-line no-async-promise-executor
    return await new Promise(async (resolve, reject) => {
        let result;

        try {
            result = await handler((err) => {
                reject(err);
            });
        } catch (err) {
            return reject(err);
        }

        return resolve(result);
    });
}
export async function nextTick(): Promise<void> {
    return await new Promise((resolve) => process.nextTick(resolve));
}
export function entries<T>(obj: Record<string, T>): ReadonlyArray<[string, T]> {
    return Object.entries(obj);
}
