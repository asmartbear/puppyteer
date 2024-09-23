

/**
 * Returns a type-guarded boolean of whether the given input is a non-empty array object.
 */
export function isNonEmptyArray<T>(arr: any): arr is T[] {
    return !!arr && Array.isArray(arr) && arr.length > 0
}

/**
 * Flattens a list-of-lists into a single list.
 */
export function flattenListOfLists<T>(list: T[][]): T[] {
    const result: T[] = []
    for (const l of list) {
        result.push(...l)
    }
    return result
}