"use client";

import { useState } from "react";
import PersonCombobox from "./PersonCombobox";
import type { TasksPerson } from "@/lib/appsScript";

/**
 * People-picker bridge for the /tasks filter form.
 *
 * The filter form is a server-rendered HTML `<form GET>` that submits
 * by URL params (so refreshes / shares of the URL preserve the active
 * filter). PersonCombobox is a controlled client component — it owns
 * its own input state and doesn't expose a native form element.
 *
 * This bridge wires the two: PersonCombobox renders the visible UI
 * with avatars + role chips + tooltips (so the filter form gets the
 * same polish as /tasks/new), and a hidden `<input>` mirrors the
 * value so the standard form submit picks it up under the original
 * param name.
 *
 * Same shape as TimePicker's hidden-mirror pattern in TaskCreateForm.
 */
export default function FilterPersonInput({
  name,
  defaultValue,
  options,
  placeholder,
}: {
  /** URL param name the form submits under (e.g. "author"). */
  name: string;
  /** Initial value seeded from the URL params on server render. */
  defaultValue: string;
  /** Roster passed through to PersonCombobox's dropdown. */
  options: TasksPerson[];
  placeholder?: string;
}) {
  const [value, setValue] = useState(defaultValue || "");
  return (
    <>
      <PersonCombobox
        value={value}
        onChange={setValue}
        options={options}
        placeholder={placeholder ?? "חפש לפי שם או מייל"}
      />
      <input type="hidden" name={name} value={value} />
    </>
  );
}
