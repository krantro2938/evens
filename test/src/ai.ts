import { GESTURE_EVENTS } from "./constants";
import { navigateBack } from "./main";
import { appLog } from "./debug";

export function handleAiPageEvent(gesture: GESTURE_EVENTS) {
    switch (gesture) {
        case GESTURE_EVENTS.DOUBLE_TAP:
            appLog("AI back gesture");
            navigateBack();
    }
}
