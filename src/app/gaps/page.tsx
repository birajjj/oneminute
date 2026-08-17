import GapsClient from "./GapsClient";

export const metadata = { title: "AI Recommendation" };

// Everything comes from localStorage (handed over by the meeting tab), so this
// page is purely client-side — no meeting has been saved yet.
export default function GapsPage() {
  return <GapsClient />;
}
