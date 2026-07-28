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

/**
 * "3m ago" — how long since something happened, in one short label.
 *
 * Here rather than beside either caller: the glasses' Setup page and the
 * companion app both age-stamp things, and a phone screen and a 576px panel
 * agreeing on the wording is the point.
 */
export function ago(at: number): string {
    const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}
