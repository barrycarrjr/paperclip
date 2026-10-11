// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CompanySkillDetail, CompanySkillFileDetail } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { SkillPane } from "./CompanySkills";

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value, frontMatter }: { value: string; frontMatter?: boolean }) => (
    <textarea
      data-testid="markdown-editor"
      data-front-matter={frontMatter ? "kept" : "markdown"}
      value={value}
      readOnly
    />
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BOM = String.fromCharCode(0xfeff);

describe("SkillPane, editing a skill file", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("has the editor keep front matter the page cannot split off", async () => {
    // A byte order mark: the page does not read this front matter, so the
    // whole file goes to the editor, which used to write it back broken.
    const content = `${BOM}---\nname: demo-skill\ndescription: Does things\n---\n\n# Demo Skill\n`;
    const detail = {
      name: "Demo Skill",
      description: null,
      key: "demo-skill",
      editable: true,
      editableReason: null,
      sourceBadge: "local",
      sourceLabel: null,
      sourcePath: null,
      sourceType: "local",
      sourceRef: null,
      usedByAgents: [],
    } as unknown as CompanySkillDetail;
    const file = { path: "SKILL.md", content, markdown: true, editable: true } as unknown as CompanySkillFileDetail;

    await act(async () => {
      root.render(
        <ToastProvider>
          <SkillPane
            loading={false}
            detail={detail}
            file={file}
            fileLoading={false}
            updateStatus={null}
            updateStatusLoading={false}
            viewMode="preview"
            editMode
            draft={content}
            setViewMode={() => {}}
            setEditMode={() => {}}
            setDraft={() => {}}
            onCheckUpdates={() => {}}
            checkUpdatesPending={false}
            onInstallUpdate={() => {}}
            installUpdatePending={false}
            onDelete={() => {}}
            deletePending={false}
            onSave={() => {}}
            savePending={false}
          />
        </ToastProvider>,
      );
    });

    const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="markdown-editor"]');
    expect(editor?.value).toBe(content);
    expect(editor?.dataset.frontMatter).toBe("kept");
  });
});
