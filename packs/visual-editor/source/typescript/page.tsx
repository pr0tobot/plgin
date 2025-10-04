"use client";
import { Editor } from "@measured/puck";
import { puckConfig } from "@/puck/puckConfig";

const initialData = {
  root: {
    type: "Group",
    props: {
      children: [
        { type: "Header", props: { title: "Project — Untitled", superscript: "by pr0to" } },
        { type: "InputBar", props: { placeholderPool: ["Generate unit tests", "Refactor my auth flow"] } },
        { type: "ImportButton", props: { importButtonText: "Import Context", isLoading: false } },
        { type: "Nav", props: { planNav: ["Requirements", "Design", "Tasks"] } },
        { type: "Columns", props: { 
          plan: [{ title: "Implement image upload", subtitle: "In component structure", tags: ["backend", "high"] }],
          automate: [],
          inProgress: [],
          done: [],
        } },
        { type: "Previews", props: { logoSrc: "/logo.png" } },
        { type: "Suggestions", props: { showSuggestions: true, line1: ["Test 1"], line2a: ["Test 2"] } },
        { type: "ImportModal", props: {} },
      ],
    },
  },
};

export default function StudioEditor() {
  return (
    <Editor
      config={puckConfig}
      initialData={initialData}
      onPublish={async (data) => {
        await fetch("/api/puck/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "studio", data }),
        });
        alert("Saved & generated TSX");
      }}
    />
  );
}