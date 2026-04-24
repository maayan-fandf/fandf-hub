"use client";

import { useState } from "react";
import type { Project } from "@/lib/appsScript";

type Companies = [string, Project[]][];

/** Per-project row state machine:
 *  - idle: show "צור Space" button (or existing Space link if one is set)
 *  - saving: button disabled, spinner label
 *  - done: show the new Space URL inline
 *  - error: show the error message with howToFix when provided */
type RowState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "done"; spaceUri: string; displayName: string }
  | { kind: "error"; error: string; howToFix?: string };

export default function ChatSpacesList({ companies }: { companies: Companies }) {
  const [states, setStates] = useState<Record<string, RowState>>({});

  async function create(project: string) {
    setStates((s) => ({ ...s, [project]: { kind: "saving" } }));
    try {
      const res = await fetch("/api/worktasks/project-space-create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project }),
      });
      const data = (await res.json()) as
        | {
            ok: true;
            space: { name: string; spaceUri?: string; displayName?: string };
          }
        | { ok: false; error: string; howToFix?: string };
      if (!data.ok) {
        setStates((s) => ({
          ...s,
          [project]: {
            kind: "error",
            error: data.error,
            howToFix: data.howToFix,
          },
        }));
        return;
      }
      setStates((s) => ({
        ...s,
        [project]: {
          kind: "done",
          spaceUri:
            data.space.spaceUri ||
            `https://mail.google.com/chat/u/0/#chat/space/${data.space.name.replace("spaces/", "")}`,
          displayName: data.space.displayName || project,
        },
      }));
    } catch (e) {
      setStates((s) => ({
        ...s,
        [project]: {
          kind: "error",
          error: e instanceof Error ? e.message : String(e),
        },
      }));
    }
  }

  return (
    <ul className="chat-spaces-list">
      {companies.map(([company, projects]) => (
        <li key={company || "(no-company)"} className="chat-spaces-company">
          <h2 className="chat-spaces-company-head">
            {company || "(ללא חברה)"}
          </h2>
          <ul className="chat-spaces-projects">
            {projects.map((p) => {
              const state: RowState = states[p.name] || { kind: "idle" };
              const hasExistingWebhook = !!p.chatSpaceUrl;
              return (
                <li key={p.name} className="chat-spaces-project">
                  <div className="chat-spaces-project-name">{p.name}</div>
                  <div className="chat-spaces-project-status">
                    {state.kind === "done" ? (
                      <a
                        href={state.spaceUri}
                        target="_blank"
                        rel="noreferrer"
                        className="chat-spaces-link"
                      >
                        ✓ נוצר · {state.displayName}
                      </a>
                    ) : hasExistingWebhook ? (
                      <a
                        href={p.chatSpaceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="chat-spaces-link"
                      >
                        💬 Webhook פעיל
                      </a>
                    ) : (
                      <span className="muted">אין Space</span>
                    )}
                  </div>
                  <div className="chat-spaces-project-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={
                        state.kind === "saving" || state.kind === "done"
                      }
                      onClick={() => create(p.name)}
                    >
                      {state.kind === "saving"
                        ? "יוצר…"
                        : state.kind === "done"
                          ? "✓ נוצר"
                          : hasExistingWebhook
                            ? "צור Space (בנוסף ל־webhook)"
                            : "צור Space"}
                    </button>
                  </div>
                  {state.kind === "error" && (
                    <div className="chat-spaces-error">
                      <b>שגיאה:</b> {state.error}
                      {state.howToFix && (
                        <div className="chat-spaces-howto">
                          <b>להפעלה:</b> {state.howToFix}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}
