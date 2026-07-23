export const BODY_W = 576;
export const BODY_H = 288;
export const BODY_PAD = 10;
export const CONTAINER_PAD = 10;
export const BODY_RADIUS = 6;
export const BODY_BORDER = 0;

export const LINE_HEIGHT = 27;

export const FOCUSED_COLOR = 7;
export const DEFAULT_COLOR = 1;

// const INNER_W = BODY_W - 2 * (BODY_PAD + BODY_BORDER)
// const INNER_H = BODY_H - 2 * (BODY_PAD + BODY_BORDER)

export const MENU_ITEMS = ["AI", "Adri", "Yula", "Photo"] as const;
export type MenuItem = (typeof MENU_ITEMS)[number];

export enum PAGES {
    DASHBOARD,
    AI,
    ADRI,
    YULA,
    PHOTO,
}

export enum GESTURE_EVENTS {
    TAP,
    DOUBLE_TAP,
    SWIPE_UP,
    SWIPE_DOWN,
}
