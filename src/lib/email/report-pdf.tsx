// Renders the meeting report as a real PDF, for attaching to the stakeholder
// email. Built with @react-pdf/renderer rather than a headless browser: it is
// pure JavaScript, so it runs inside a serverless function without shipping a
// ~50MB Chromium binary or paying its cold-start cost.
//
// Layout mirrors the on-screen report — actions, then decisions, then notes.
//
// SERVER-ONLY.

import React from "react";
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import type { ReportContent, ReportRow } from "./report-data";
import { FLAGS } from "./report-data";

const COLOURS = {
  ink: "#0f172a",
  body: "#334155",
  muted: "#64748b",
  faint: "#94a3b8",
  rule: "#e2e8f0",
  card: "#f8fafc",
  blue: "#2563eb",
  green: "#059669",
  purple: "#7c3aed",
  slate: "#64748b"
};

const s = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 52, paddingHorizontal: 44, fontSize: 10, color: COLOURS.body },
  project: { fontSize: 8, color: COLOURS.blue, letterSpacing: 1, textTransform: "uppercase" },
  title: { fontSize: 18, color: COLOURS.ink, marginTop: 4, fontWeight: 700 },
  date: { fontSize: 10, color: COLOURS.muted, marginTop: 2 },
  rule: { borderBottomWidth: 1, borderBottomColor: COLOURS.rule, marginVertical: 12 },

  noteBox: { backgroundColor: "#eff6ff", borderLeftWidth: 3, borderLeftColor: COLOURS.blue, padding: 8, marginBottom: 12 },
  noteText: { color: "#1e3a8a", lineHeight: 1.5 },

  h2: { fontSize: 9, letterSpacing: 1, textTransform: "uppercase", fontWeight: 700, marginTop: 14, marginBottom: 6 },
  summary: { lineHeight: 1.5, color: COLOURS.body },

  // Each item is kept whole across a page break (`wrap={false}` below).
  item: { backgroundColor: COLOURS.card, borderLeftWidth: 3, padding: 8, marginBottom: 6 },
  itemHead: { flexDirection: "row", alignItems: "center", marginBottom: 3 },
  badge: { fontSize: 7, color: "#334155", backgroundColor: "#e2e8f0", paddingVertical: 2, paddingHorizontal: 4, marginRight: 5 },
  itemTitle: { fontSize: 10, fontWeight: 700, color: COLOURS.ink, flexGrow: 1, flexShrink: 1 },
  status: { fontSize: 8, color: COLOURS.muted, marginLeft: 5 },
  body: { lineHeight: 1.45, color: COLOURS.body },
  meta: { flexDirection: "row", flexWrap: "wrap", marginTop: 4 },
  flag: { fontSize: 7, color: "#6d28d9", backgroundColor: "#ede9fe", paddingVertical: 2, paddingHorizontal: 4, marginRight: 4 },
  metaText: { fontSize: 8, color: COLOURS.faint },

  footer: {
    position: "absolute",
    bottom: 26,
    left: 44,
    right: 44,
    fontSize: 8,
    color: COLOURS.faint,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: COLOURS.rule,
    paddingTop: 6
  }
});

function Item({ row, accent }: { row: ReportRow; accent: string }) {
  const meta = [row.owner, row.due ? `due ${row.due}` : null, row.area].filter(Boolean).join("  ·  ");
  const flags = row.tags.filter((t) => FLAGS.includes(t));
  return (
    // wrap={false} keeps a single item from splitting across pages.
    <View style={[s.item, { borderLeftColor: accent }]} wrap={false}>
      <View style={s.itemHead}>
        <Text style={s.badge}>{row.type}</Text>
        <Text style={s.itemTitle}>{row.title}</Text>
        <Text style={s.status}>{row.status}</Text>
      </View>
      {row.note ? <Text style={s.body}>{row.note}</Text> : null}
      {(flags.length > 0 || meta) && (
        <View style={s.meta}>
          {flags.map((f) => (
            <Text key={f} style={s.flag}>
              {f}
            </Text>
          ))}
          {meta ? <Text style={s.metaText}>{meta}</Text> : null}
        </View>
      )}
    </View>
  );
}

function Section({
  heading,
  colour,
  rows
}: {
  heading: string;
  colour: string;
  rows: ReportRow[];
}) {
  if (rows.length === 0) return null;
  return (
    <View>
      <Text style={[s.h2, { color: colour }]}>
        {heading}  {rows.length}
      </Text>
      {rows.map((r, i) => (
        <Item key={i} row={r} accent={colour} />
      ))}
    </View>
  );
}

function ReportDocument({ content, note }: { content: ReportContent; note: string }) {
  return (
    <Document
      title={`${content.meetingTitle} — meeting report`}
      author="OneMinute"
      subject={content.projectName}
    >
      <Page size="A4" style={s.page}>
        <Text style={s.project}>{content.projectName}</Text>
        <Text style={s.title}>{content.meetingTitle}</Text>
        <Text style={s.date}>{content.when}</Text>
        <View style={s.rule} />

        {note.trim() ? (
          <View style={s.noteBox}>
            <Text style={s.noteText}>{note.trim()}</Text>
          </View>
        ) : null}

        {content.summary ? (
          <View>
            <Text style={[s.h2, { color: COLOURS.muted, marginTop: 0 }]}>Summary</Text>
            <Text style={s.summary}>{content.summary}</Text>
          </View>
        ) : null}

        <Section heading="Actions, to-dos & devops" colour={COLOURS.green} rows={content.actions} />
        <Section heading="Decisions, scope & governance" colour={COLOURS.purple} rows={content.decisions} />
        <Section heading="Notes & discussion" colour={COLOURS.slate} rows={content.notes} />

        <View style={s.footer} fixed>
          <Text>
            {content.projectName} · {content.meetingTitle}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export async function renderReportPdf(content: ReportContent, note: string): Promise<Buffer> {
  return renderToBuffer(<ReportDocument content={content} note={note} />);
}
