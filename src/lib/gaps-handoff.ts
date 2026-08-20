// Hand-off between a live meeting page and the "What did I miss?" comparison
// page, which opens in its own tab so the meeting page is never navigated away
// from while a recording is running.
//
// localStorage (not sessionStorage) because the two tabs must see the same data,
// and the `storage` event lets the meeting tab pick up accepted suggestions live.

export const GAPS_PAYLOAD_KEY = "oneminute:gaps:payload";
export const GAPS_ACCEPTED_KEY = "oneminute:gaps:accepted";

export interface CapturedItem {
  title: string;
  description: string;
  type: string;
}

export interface GapsPayload {
  source: "auto" | "followup" | "browse";
  // Set when the meeting is already saved (Browse): accepting a suggestion
  // writes it straight to that meeting instead of into a draft.
  meetingId?: string;
  // Which project's learned house style to apply to the suggestions.
  projectId?: string;
  meetingTitle: string;
  transcript: string;
  captured: CapturedItem[];
  areas: string[];
}

export interface AcceptedItem {
  title: string;
  description: string;
  minuteType: string;
  area: string;
}

export function writeGapsPayload(p: GapsPayload): void {
  try {
    localStorage.setItem(GAPS_PAYLOAD_KEY, JSON.stringify(p));
    localStorage.removeItem(GAPS_ACCEPTED_KEY); // fresh session
  } catch {
    /* storage full / disabled — the comparison page will show its own message */
  }
}

export function readGapsPayload(): GapsPayload | null {
  try {
    const raw = localStorage.getItem(GAPS_PAYLOAD_KEY);
    return raw ? (JSON.parse(raw) as GapsPayload) : null;
  } catch {
    return null;
  }
}

/** Comparison page -> meeting page. Appends; the meeting tab drains the queue. */
export function pushAccepted(item: AcceptedItem): void {
  try {
    const raw = localStorage.getItem(GAPS_ACCEPTED_KEY);
    const list: AcceptedItem[] = raw ? JSON.parse(raw) : [];
    list.push(item);
    localStorage.setItem(GAPS_ACCEPTED_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

/** Meeting page: take everything accepted so far and clear the queue. */
export function drainAccepted(): AcceptedItem[] {
  try {
    const raw = localStorage.getItem(GAPS_ACCEPTED_KEY);
    if (!raw) return [];
    localStorage.removeItem(GAPS_ACCEPTED_KEY);
    return JSON.parse(raw) as AcceptedItem[];
  } catch {
    return [];
  }
}
