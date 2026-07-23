export function stringToShortId(str: string): number {
    let hash = 0;

    for (let i = 0; i < str.length; i++) {
        const charCode = str.charCodeAt(i);
        hash = (hash << 5) - hash + charCode; // hash * 31 + charCode
        hash |= 0; // force 32-bit integer
    }

    // Make sure it's non-negative
    return Math.abs(hash) % 1024;
}
