import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Bot, Check, Loader2, X, Phone, Mail, Calendar, MessageSquare, Play, Square, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { authApi } from "../api/auth";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { agentRouteRef } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

type AssistantType = "ea" | "custom";

interface PhoneNumber {
  id: string;
  e164: string;
  label: string | null;
  /** Verified personal caller ID (vs an engine-owned number). */
  personal?: boolean;
}

interface NumbersResponse {
  numbers: PhoneNumber[];
  engine?: "vapi" | "diy";
  /** True if the resolved phone-tools account has Twilio creds. */
  twilioConfigured?: boolean;
}

interface VerifyRequestResponse {
  e164: string;
  validationCode: string;
  friendlyName: string;
  callSid: string | null;
  instructions: string;
}

interface ComposeResult {
  firstMessage: string;
  systemPrompt: string;
}

/**
 * Subset of the plugin's PhoneConfig shape that the edit-mode hydration
 * cares about. Mirrors the fields the wizard writes — leaves the
 * engine-side and operational fields (vapiAssistantId, transferTarget…)
 * untouched on save so editing an assistant's wizard answers doesn't
 * accidentally wipe operator-configured warm-transfer settings.
 */
interface ExistingPhoneConfig {
  voice?: string;
  callerIdNumberId?: string;
  firstMessage?: string;
  wizardAnswers?: Record<string, unknown>;
}

interface OperatorPhone {
  e164: string | null;
  verifiedAt: string | null;
}

const EA_TASKS = [
  { id: "schedule-meetings", label: "Schedule meetings" },
  { id: "take-messages", label: "Take messages" },
  { id: "confirm-appointments", label: "Confirm appointments" },
  { id: "follow-up", label: "Follow up after calls" },
  { id: "gather-information", label: "Gather information" },
] as const;

const VOICES = [
  { id: "alloy", label: "Alloy", subtitle: "Warm, friendly", sampleUrl: "https://cdn.openai.com/API/docs/audio/alloy.wav" },
  { id: "echo", label: "Echo", subtitle: "Clear, direct", sampleUrl: "https://cdn.openai.com/API/docs/audio/echo.wav" },
  { id: "shimmer", label: "Shimmer", subtitle: "Bright, upbeat", sampleUrl: "https://cdn.openai.com/API/docs/audio/shimmer.wav" },
  { id: "onyx", label: "Onyx", subtitle: "Deep, calm", sampleUrl: "https://cdn.openai.com/API/docs/audio/onyx.wav" },
] as const;

const TOTAL_STEPS = 8;
const PLUGIN_KEY = "phone-tools";

async function pluginFetch<T = unknown>(
  path: string,
  init: RequestInit & { companyId: string },
): Promise<T> {
  const url = new URL(`/api/plugins/${PLUGIN_KEY}/api${path}`, window.location.origin);
  url.searchParams.set("companyId", init.companyId);
  const res = await fetch(url.toString(), {
    method: init.method ?? "GET",
    credentials: "include",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
    body: init.body,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string")
        ? (payload as { error: string }).error
        : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export function AssistantWizard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();
  const { agentId: editingAgentId } = useParams<{ agentId?: string }>();
  const isEditMode = !!editingAgentId;

  useEffect(() => {
    setBreadcrumbs([
      { label: "Assistants", href: "/assistants" },
      { label: isEditMode ? "Edit Assistant" : "New Assistant" },
    ]);
  }, [setBreadcrumbs, isEditMode]);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userDisplayName = session?.user?.name?.trim() || "you";

  const [step, setStep] = useState<number>(1);
  const [error, setError] = useState<string | null>(null);

  // Step 1
  const [type, setType] = useState<AssistantType>("ea");
  // Step 2
  const [name, setName] = useState("");
  // Step 3
  const [principal, setPrincipal] = useState("");
  // Step 4
  const [tasks, setTasks] = useState<string[]>(EA_TASKS.map((t) => t.id));
  const [customTasks, setCustomTasks] = useState("");
  // Step 5 — capability checklist
  const [phoneEnabled, setPhoneEnabled] = useState(true);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [calendarEnabled, setCalendarEnabled] = useState(false);
  // Step 6
  const [voice, setVoice] = useState<string>(VOICES[0]!.id);
  // Step 7
  const [callerIdNumberId, setCallerIdNumberId] = useState<string>("");

  // Pre-fill principal from session user once available.
  useEffect(() => {
    if (!principal && session?.user?.name) {
      setPrincipal(session.user.name);
    }
  }, [session?.user?.name, principal]);

  // Phone numbers — fetched from the plugin's account. Returns both
  // engine-owned numbers and locally-cached verified personal caller
  // IDs, plus engine + twilioConfigured flags so the UI can show the
  // right verification affordances.
  const numbersQuery = useQuery({
    queryKey: ["phone-tools", "phone-numbers", selectedCompanyId],
    queryFn: () => pluginFetch<NumbersResponse>("/accounts/numbers", {
      method: "GET",
      companyId: selectedCompanyId!,
    }),
    enabled: !!selectedCompanyId && step >= 7,
  });

  useEffect(() => {
    if (!callerIdNumberId && numbersQuery.data?.numbers && numbersQuery.data.numbers.length > 0) {
      setCallerIdNumberId(numbersQuery.data.numbers[0]!.id);
    }
  }, [numbersQuery.data, callerIdNumberId]);

  // Operator phone — for Test on my phone.
  const operatorPhoneQuery = useQuery({
    queryKey: ["phone-tools", "operator-phone", selectedCompanyId],
    queryFn: () => pluginFetch<OperatorPhone>("/operator-phone", {
      method: "GET",
      companyId: selectedCompanyId!,
    }),
    enabled: !!selectedCompanyId && step >= 8,
  });
  const [operatorPhoneDraft, setOperatorPhoneDraft] = useState("");
  useEffect(() => {
    if (operatorPhoneQuery.data?.e164 && !operatorPhoneDraft) {
      setOperatorPhoneDraft(operatorPhoneQuery.data.e164);
    }
  }, [operatorPhoneQuery.data?.e164, operatorPhoneDraft]);

  // First-message override: the wizard's composed default contains a
  // `{the reason for call}` placeholder that the operator should replace before
  // saving (the engine speaks firstMessage verbatim). Null = use the composed
  // default as-is; non-null = operator typed over it.
  const [firstMessageOverride, setFirstMessageOverride] = useState<string | null>(null);

  // ─── Edit-mode hydration ───────────────────────────────────────────
  // When the route is /assistants/:agentId/edit, fetch the agent's existing
  // phone-config + agent record and pre-fill every wizard step. The agent
  // record gives us name; the phone-config stores wizardAnswers (which has
  // everything else — principal, tasks, capabilities, voice, caller ID) as
  // well as voice/callerId fields directly + the operator's first-message
  // override. Hydration runs exactly once per agentId so navigating between
  // steps doesn't overwrite the user's in-progress edits.
  const existingAgentQuery = useQuery({
    queryKey: queryKeys.agents.detail(editingAgentId ?? ""),
    queryFn: () => agentsApi.get(editingAgentId!, selectedCompanyId!),
    enabled: isEditMode && !!editingAgentId && !!selectedCompanyId,
  });
  const existingPhoneConfigQuery = useQuery({
    queryKey: ["phone-tools", "phone-config", editingAgentId, selectedCompanyId],
    queryFn: () =>
      pluginFetch<{ config: ExistingPhoneConfig | null }>(
        "/assistants/" + editingAgentId + "/phone-config",
        { method: "GET", companyId: selectedCompanyId! },
      ),
    enabled: isEditMode && !!editingAgentId && !!selectedCompanyId,
  });
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!isEditMode || hydrated) return;
    const agent = existingAgentQuery.data;
    const cfg = existingPhoneConfigQuery.data?.config ?? null;
    if (!agent || !existingPhoneConfigQuery.data) return;
    // Hydrate from the agent + (optional) phone-config.
    if (agent.name) setName(agent.name);
    const wa = (cfg?.wizardAnswers ?? {}) as Partial<{
      type: AssistantType;
      principal: string;
      tasks: string[];
      customTasks: string;
      phoneEnabled: boolean;
      emailEnabled: boolean;
      calendarEnabled: boolean;
      voice: string;
      callerIdNumberId: string;
    }>;
    if (wa.type === "ea" || wa.type === "custom") setType(wa.type);
    if (typeof wa.principal === "string" && wa.principal) setPrincipal(wa.principal);
    if (Array.isArray(wa.tasks)) setTasks(wa.tasks);
    if (typeof wa.customTasks === "string") setCustomTasks(wa.customTasks);
    // Capability flags: respect what's stored. Phone defaults true if
    // a config exists at all (legacy configs without an explicit flag).
    setPhoneEnabled(cfg ? wa.phoneEnabled !== false : true);
    setEmailEnabled(wa.emailEnabled === true);
    setCalendarEnabled(wa.calendarEnabled === true);
    if (typeof cfg?.voice === "string") setVoice(cfg.voice);
    else if (typeof wa.voice === "string") setVoice(wa.voice);
    if (typeof cfg?.callerIdNumberId === "string") setCallerIdNumberId(cfg.callerIdNumberId);
    else if (typeof wa.callerIdNumberId === "string") setCallerIdNumberId(wa.callerIdNumberId);
    if (typeof cfg?.firstMessage === "string") setFirstMessageOverride(cfg.firstMessage);
    setHydrated(true);
  }, [
    isEditMode,
    hydrated,
    existingAgentQuery.data,
    existingPhoneConfigQuery.data,
  ]);

  const wizardAnswers = useMemo(
    () => ({
      type,
      name: name.trim(),
      principal: principal.trim() || userDisplayName,
      tasks,
      customTasks: customTasks.trim(),
      phoneEnabled,
      emailEnabled,
      calendarEnabled,
      voice,
      callerIdNumberId,
    }),
    [type, name, principal, tasks, customTasks, phoneEnabled, emailEnabled, calendarEnabled, voice, callerIdNumberId, userDisplayName],
  );

  // Compose preview for Q8.
  const composeQuery = useQuery({
    queryKey: ["phone-tools", "compose-preview", JSON.stringify(wizardAnswers), selectedCompanyId],
    queryFn: () => pluginFetch<ComposeResult>("/assistants/compose-preview", {
      method: "POST",
      companyId: selectedCompanyId!,
      body: JSON.stringify({ answers: wizardAnswers }),
    }),
    enabled: !!selectedCompanyId && step === 8 && !!name.trim(),
  });

  const saveOperatorPhone = useMutation({
    mutationFn: (e164: string) =>
      pluginFetch<OperatorPhone>("/operator-phone", {
        method: "POST",
        companyId: selectedCompanyId!,
        body: JSON.stringify({ e164 }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["phone-tools", "operator-phone", selectedCompanyId] });
    },
  });

  const [savedAssistantId, setSavedAssistantId] = useState<string | null>(null);
  const [savedAssistantRouteRef, setSavedAssistantRouteRef] = useState<string | null>(null);

  async function saveAssistant({ activate }: { activate: boolean }): Promise<{ id: string; routeRef: string } | null> {
    if (!selectedCompanyId) {
      setError("No company selected.");
      return null;
    }
    if (!name.trim()) {
      setError("Give your assistant a name first.");
      setStep(2);
      return null;
    }
    setError(null);
    try {
      const compose = composeQuery.data
        ?? (await pluginFetch<ComposeResult>("/assistants/compose-preview", {
          method: "POST",
          companyId: selectedCompanyId,
          body: JSON.stringify({ answers: wizardAnswers }),
        }));

      let agent: Agent;
      if (isEditMode && editingAgentId) {
        // ── Edit existing assistant ────────────────────────────
        // No hire / approval — agent already exists. Patch the name +
        // title (and metadata, in case the EA-vs-custom type changed)
        // so renames flow through to listings everywhere.
        agent = await agentsApi.update(
          editingAgentId,
          {
            name: name.trim(),
            title: type === "ea" ? "Personal EA" : "Custom assistant",
            metadata: {
              assistantType: type,
              assistantPrincipal: principal.trim() || userDisplayName,
            },
          },
          selectedCompanyId,
        );
      } else {
        // ── Create new assistant ───────────────────────────────
        // Use the hire endpoint so companies that require board
        // approval for new agents go through the approval flow. On a
        // personal-fork setup the operator IS the board, so we
        // auto-approve. On a real multi-board setup the approval
        // lands in the company's queue.
        const hire = await agentsApi.hire(selectedCompanyId, {
          name: name.trim(),
          role: "assistant",
          title: type === "ea" ? "Personal EA" : "Custom assistant",
          adapterType: "claude_local",
          adapterConfig: {},
          runtimeConfig: {},
          metadata: {
            assistantType: type,
            assistantPrincipal: principal.trim() || userDisplayName,
          },
        });
        agent = hire.agent;
        if (hire.approval) {
          try {
            await approvalsApi.approve(
              hire.approval.id,
              "Approved by Assistant Builder wizard.",
            );
            queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId) });
          } catch (approvalErr) {
            // Don't block save if auto-approve fails — the operator can
            // approve manually from the Approvals page later.
            console.warn("Assistant auto-approve failed", approvalErr);
          }
        }
      }

      // Write the composed system prompt into the agent's instructions
      // bundle. Both create and edit go through here so an edit picks
      // up changes from the new wizard answers (capabilities, tasks,
      // principal, etc.) on the next call.
      await agentsApi.saveInstructionsFile(
        agent.id,
        { path: "AGENTS.md", content: compose.systemPrompt },
        selectedCompanyId,
      );

      // Tell the phone-tools plugin to mirror this assistant onto the engine
      // and save its per-agent phone config.
      if (phoneEnabled) {
        await pluginFetch("/assistants/" + agent.id + "/phone-config", {
          method: "POST",
          companyId: selectedCompanyId,
          body: JSON.stringify({
            voice,
            callerIdNumberId,
            costCapDailyUsd: 10,
            enabled: true,
            firstMessage: firstMessageOverride ?? compose.firstMessage,
            wizardAnswers,
          }),
        });
      }

      // Only pause on the create path. Edits should never auto-pause
      // an already-active assistant — that would silently knock it
      // offline behind the operator's back.
      if (!isEditMode && !activate) {
        await agentsApi.pause(agent.id, selectedCompanyId);
      }

      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({
        queryKey: ["phone-tools", "phone-config", agent.id, selectedCompanyId],
      });

      setSavedAssistantId(agent.id);
      const routeRef = agentRouteRef(agent);
      setSavedAssistantRouteRef(routeRef);
      return { id: agent.id, routeRef };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save assistant");
      return null;
    }
  }

  function navigateToAssistant(routeRef: string) {
    navigate(`/agents/${routeRef}/plugin:${PLUGIN_KEY}:agent-phone-tab`);
  }

  function canAdvanceFrom(currentStep: number): boolean {
    if (currentStep === 1) return true;
    if (currentStep === 2) return name.trim().length > 0;
    if (currentStep === 3) return (principal.trim() || userDisplayName).length > 0;
    if (currentStep === 4) return true;
    if (currentStep === 5) return phoneEnabled || emailEnabled || calendarEnabled;
    if (currentStep === 6) return !phoneEnabled || !!voice;
    if (currentStep === 7) return !phoneEnabled || !!callerIdNumberId;
    return true;
  }

  if (!selectedCompanyId) {
    return (
      <div className="mx-auto max-w-2xl py-10 text-center text-sm text-muted-foreground">
        Select a company to create an assistant.
      </div>
    );
  }

  // Edit-mode initial load — show a small spinner instead of the blank
  // form so the user doesn't briefly see defaults before hydration.
  if (isEditMode && !hydrated) {
    if (existingAgentQuery.error || existingPhoneConfigQuery.error) {
      const message = (existingAgentQuery.error ?? existingPhoneConfigQuery.error) as Error;
      return (
        <div className="mx-auto max-w-2xl py-10 text-center text-sm text-destructive">
          Couldn't load this assistant: {message.message}
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-2xl py-10 flex items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading assistant…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl py-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Bot className="h-4 w-4" />
          <span>{isEditMode ? `Edit ${name.trim() || "Assistant"}` : "New Assistant"}</span>
          <span className="opacity-50">·</span>
          <span>Step {step} of {TOTAL_STEPS}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => navigate("/assistants")}
          aria-label="Cancel"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="border border-border bg-card p-6 space-y-5">
        {step === 1 && (
          <Step1
            type={type}
            onSelect={(value) => {
              setType(value);
              if (value === "custom") setTasks([]);
              else setTasks(EA_TASKS.map((t) => t.id));
            }}
          />
        )}
        {step === 2 && <Step2 name={name} onChange={setName} type={type} />}
        {step === 3 && (
          <Step3
            principal={principal}
            placeholder={userDisplayName}
            onChange={setPrincipal}
            assistantName={name.trim() || "your assistant"}
          />
        )}
        {step === 4 && (
          <Step4
            type={type}
            tasks={tasks}
            customTasks={customTasks}
            onTasksChange={setTasks}
            onCustomChange={setCustomTasks}
          />
        )}
        {step === 5 && (
          <Step5
            phoneEnabled={phoneEnabled}
            onPhoneChange={setPhoneEnabled}
            emailEnabled={emailEnabled}
            onEmailChange={setEmailEnabled}
            calendarEnabled={calendarEnabled}
            onCalendarChange={setCalendarEnabled}
          />
        )}
        {step === 6 && (
          <Step6 voice={voice} onChange={setVoice} />
        )}
        {step === 7 && (
          <Step7
            numbers={numbersQuery.data?.numbers ?? []}
            engine={numbersQuery.data?.engine ?? null}
            twilioConfigured={numbersQuery.data?.twilioConfigured ?? false}
            isLoading={numbersQuery.isLoading}
            errorMessage={numbersQuery.error instanceof Error ? numbersQuery.error.message : null}
            value={callerIdNumberId}
            onChange={setCallerIdNumberId}
            companyId={selectedCompanyId}
            onNumbersChanged={() => {
              queryClient.invalidateQueries({
                queryKey: ["phone-tools", "phone-numbers", selectedCompanyId],
              });
            }}
          />
        )}
        {step === 8 && (
          <Step8
            answers={wizardAnswers}
            voiceLabel={VOICES.find((v) => v.id === voice)?.label ?? voice}
            callerIdLabel={
              numbersQuery.data?.numbers.find((n) => n.id === callerIdNumberId)?.e164
                ?? callerIdNumberId
            }
            preview={composeQuery.data ?? null}
            previewLoading={composeQuery.isLoading}
            previewError={composeQuery.error instanceof Error ? composeQuery.error.message : null}
            firstMessageOverride={firstMessageOverride}
            onFirstMessageChange={setFirstMessageOverride}
            operatorPhone={operatorPhoneDraft}
            onOperatorPhoneChange={setOperatorPhoneDraft}
            onSaveOperatorPhone={() => saveOperatorPhone.mutate(operatorPhoneDraft.trim())}
            isSavingOperatorPhone={saveOperatorPhone.isPending}
            verifiedOperatorPhone={operatorPhoneQuery.data?.e164 ?? null}
            assistantId={savedAssistantId}
            assistantRouteRef={savedAssistantRouteRef}
            onTest={async () => {
              const trimmed = operatorPhoneDraft.trim();
              if (!trimmed) {
                setError("Add the number to call before testing.");
                return;
              }
              if (!operatorPhoneQuery.data?.e164 || operatorPhoneQuery.data.e164 !== trimmed) {
                await saveOperatorPhone.mutateAsync(trimmed);
              }
              let target: { id: string; routeRef: string } | null = savedAssistantId && savedAssistantRouteRef
                ? { id: savedAssistantId, routeRef: savedAssistantRouteRef }
                : null;
              if (!target) target = await saveAssistant({ activate: false });
              if (!target) return;
              try {
                await pluginFetch(`/assistants/${target.id}/phone-config/test`, {
                  method: "POST",
                  companyId: selectedCompanyId,
                  body: JSON.stringify({ to: trimmed }),
                });
                navigateToAssistant(target.routeRef);
              } catch (err) {
                setError(err instanceof Error ? err.message : "Test call failed.");
              }
            }}
          />
        )}

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        <div className="flex items-center justify-between pt-2">
          {step > 1 ? (
            <Button variant="ghost" size="sm" onClick={() => setStep((s) => Math.max(1, s - 1))}>
              <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
              Back
            </Button>
          ) : (
            <span />
          )}
          {step < TOTAL_STEPS ? (
            <Button
              size="sm"
              disabled={!canAdvanceFrom(step)}
              onClick={() => setStep((s) => Math.min(TOTAL_STEPS, s + 1))}
            >
              Next
              <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
            </Button>
          ) : isEditMode ? (
            <Button
              size="sm"
              onClick={async () => {
                const target = await saveAssistant({ activate: true });
                if (target) navigateToAssistant(target.routeRef);
              }}
            >
              <Check className="h-3.5 w-3.5 mr-1.5" />
              Save changes
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const target = await saveAssistant({ activate: false });
                  if (target) navigate("/assistants");
                }}
              >
                Save as draft
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  const target = await saveAssistant({ activate: true });
                  if (target) navigateToAssistant(target.routeRef);
                }}
              >
                <Check className="h-3.5 w-3.5 mr-1.5" />
                Save &amp; activate
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Step components -------------------------------------------------------

function Step1({ type, onSelect }: { type: AssistantType; onSelect: (v: AssistantType) => void }) {
  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold">What kind of assistant?</h2>
      <p className="text-sm text-muted-foreground">
        Pick a starting point. You can change everything later.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Card
          selected={type === "ea"}
          onClick={() => onSelect("ea")}
          title="Personal EA"
          subtitle="Personal executive assistant — schedules, confirms, and follows up on your behalf."
          recommended
        />
        <Card
          selected={type === "custom"}
          onClick={() => onSelect("custom")}
          title="Custom"
          subtitle="Start with a blank slate and write the instructions yourself later."
        />
      </div>
    </div>
  );
}

function Step2({ name, onChange, type }: { name: string; onChange: (v: string) => void; type: AssistantType }) {
  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">What should I call them?</h2>
      <p className="text-sm text-muted-foreground">
        This is the name your assistant uses when introducing itself on calls.
      </p>
      <input
        type="text"
        value={name}
        onChange={(e) => onChange(e.target.value)}
        placeholder={type === "ea" ? "e.g. Alex" : "e.g. Vendor follow-up bot"}
        className="w-full border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:border-foreground/40"
        autoFocus
      />
    </div>
  );
}

function Step3({
  principal,
  placeholder,
  onChange,
  assistantName,
}: {
  principal: string;
  placeholder: string;
  onChange: (v: string) => void;
  assistantName: string;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">Who do they help?</h2>
      <p className="text-sm text-muted-foreground">
        {assistantName} will introduce themselves as calling on behalf of this person.
      </p>
      <input
        type="text"
        value={principal}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:border-foreground/40"
      />
    </div>
  );
}

function Step4({
  type,
  tasks,
  customTasks,
  onTasksChange,
  onCustomChange,
}: {
  type: AssistantType;
  tasks: string[];
  customTasks: string;
  onTasksChange: (v: string[]) => void;
  onCustomChange: (v: string) => void;
}) {
  function toggle(id: string) {
    onTasksChange(tasks.includes(id) ? tasks.filter((t) => t !== id) : [...tasks, id]);
  }
  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">What can they help with?</h2>
      <p className="text-sm text-muted-foreground">
        {type === "ea"
          ? "Pre-checked for Personal EAs. Uncheck anything that doesn't apply."
          : "Pick anything you want this assistant to handle."}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {EA_TASKS.map((task) => (
          <CheckRow
            key={task.id}
            checked={tasks.includes(task.id)}
            onChange={() => toggle(task.id)}
            label={task.label}
          />
        ))}
      </div>
      <div className="pt-2">
        <label className="block text-xs text-muted-foreground mb-1">Anything else? (free-form)</label>
        <textarea
          value={customTasks}
          onChange={(e) => onCustomChange(e.target.value)}
          placeholder="e.g. Reschedule Tuesday's vendor call to Wednesday at 3pm ET if needed."
          className="w-full border border-border bg-transparent px-3 py-2 text-sm h-20 focus:outline-none focus:border-foreground/40"
        />
      </div>
    </div>
  );
}

function Step5({
  phoneEnabled,
  onPhoneChange,
  emailEnabled,
  onEmailChange,
  calendarEnabled,
  onCalendarChange,
}: {
  phoneEnabled: boolean;
  onPhoneChange: (v: boolean) => void;
  emailEnabled: boolean;
  onEmailChange: (v: boolean) => void;
  calendarEnabled: boolean;
  onCalendarChange: (v: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">What can they do?</h2>
      <p className="text-sm text-muted-foreground">
        Pick the channels this assistant can use. They draw on the email-tools and
        google-workspace plugins — make sure those are connected for this company.
        SMS is still on the way.
      </p>
      <div className="flex flex-col gap-2">
        <CapabilityRow
          icon={Phone}
          label="Phone"
          subtitle="Make and receive AI-driven phone calls."
          available
          checked={phoneEnabled}
          onChange={onPhoneChange}
        />
        <CapabilityRow
          icon={Mail}
          label="Email"
          subtitle="Read, draft, and send email on your behalf via email-tools."
          available
          checked={emailEnabled}
          onChange={onEmailChange}
        />
        <CapabilityRow
          icon={Calendar}
          label="Calendar"
          subtitle="Schedule, reschedule, decline via google-workspace."
          available
          checked={calendarEnabled}
          onChange={onCalendarChange}
        />
        <CapabilityRow icon={MessageSquare} label="SMS" subtitle="Send and reply to text messages." available={false} />
      </div>
    </div>
  );
}

function Step6({ voice, onChange }: { voice: string; onChange: (v: string) => void }) {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Stop any in-flight playback when this step unmounts.
  useEffect(() => {
    return () => {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.src = "";
      }
    };
  }, []);

  function togglePlay(voiceId: string, sampleUrl: string) {
    const audio = audioRef.current;
    if (!audio) return;
    if (playingId === voiceId) {
      audio.pause();
      setPlayingId(null);
      return;
    }
    audio.pause();
    audio.src = sampleUrl;
    setPlayingId(voiceId);
    audio.play().catch(() => {
      setPlayingId(null);
    });
  }

  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">Voice</h2>
      <p className="text-sm text-muted-foreground">
        Pick the voice your assistant will use on calls. Tap ▶ to hear a short sample.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {VOICES.map((v) => {
          const isPlaying = playingId === v.id;
          const isSelected = voice === v.id;
          return (
            <div
              key={v.id}
              role="button"
              tabIndex={0}
              onClick={() => onChange(v.id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onChange(v.id); }}
              className={cn(
                "text-left border bg-card p-4 transition-colors cursor-pointer",
                isSelected ? "border-foreground" : "border-border hover:border-foreground/40",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium text-sm">{v.label}</div>
                  <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{v.subtitle}</p>
                </div>
                <button
                  type="button"
                  aria-label={isPlaying ? `Stop ${v.label} sample` : `Play ${v.label} sample`}
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlay(v.id, v.sampleUrl);
                  }}
                  className={cn(
                    "shrink-0 inline-flex items-center justify-center h-7 w-7 border rounded-full transition-colors",
                    isPlaying
                      ? "border-foreground bg-foreground text-background"
                      : "border-border hover:border-foreground/40 hover:bg-accent/50",
                  )}
                >
                  {isPlaying ? <Square className="h-3 w-3" /> : <Play className="h-3.5 w-3.5 ml-0.5" />}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {/* Single shared audio element — only one voice plays at a time. */}
      <audio
        ref={audioRef}
        onEnded={() => setPlayingId(null)}
        onError={() => setPlayingId(null)}
        preload="none"
      />
    </div>
  );
}

function Step7({
  numbers,
  engine,
  twilioConfigured,
  isLoading,
  errorMessage,
  value,
  onChange,
  companyId,
  onNumbersChanged,
}: {
  numbers: PhoneNumber[];
  engine: "vapi" | "diy" | null;
  twilioConfigured: boolean;
  isLoading: boolean;
  errorMessage: string | null;
  value: string;
  onChange: (v: string) => void;
  companyId: string | null;
  onNumbersChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [personalE164, setPersonalE164] = useState("");
  const [personalLabel, setPersonalLabel] = useState("");
  const [pending, setPending] = useState<VerifyRequestResponse | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const selectedIsPersonal = numbers.find((n) => n.id === value)?.personal === true;
  const vapiPersonalUnsupported = selectedIsPersonal && engine === "vapi";

  async function startVerification() {
    if (!companyId) return;
    setVerifyError(null);
    try {
      const res = await pluginFetch<VerifyRequestResponse>("/accounts/verified-callers/request", {
        method: "POST",
        companyId,
        body: JSON.stringify({
          e164: personalE164.trim(),
          label: personalLabel.trim() || undefined,
        }),
      });
      setPending(res);
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "Verification failed.");
    }
  }

  async function refreshFromTwilio() {
    if (!companyId) return;
    setVerifyError(null);
    try {
      await pluginFetch("/accounts/verified-callers/refresh", {
        method: "POST",
        companyId,
        body: JSON.stringify({}),
      });
      onNumbersChanged();
      // If the pending number now shows up, clear the pending state.
      setPending(null);
      setAdding(false);
      setPersonalE164("");
      setPersonalLabel("");
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "Refresh failed.");
    }
  }

  async function deletePersonal(sid: string) {
    if (!companyId) return;
    try {
      await pluginFetch(`/accounts/verified-callers/${encodeURIComponent(sid)}`, {
        method: "DELETE",
        companyId,
      });
      onNumbersChanged();
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">Caller ID</h2>
      <p className="text-sm text-muted-foreground">
        Calls placed by this assistant will show this number. Pick an engine-owned
        number, or verify your own cell so the assistant calls "from your phone."
      </p>
      {isLoading && <p className="text-sm text-muted-foreground">Loading numbers…</p>}
      {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
      {!isLoading && !errorMessage && numbers.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No phone numbers configured. Add one on the phone-tools settings page first.
        </p>
      )}
      {numbers.length > 0 && (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:border-foreground/40"
        >
          {numbers.map((n) => (
            <option key={n.id} value={n.id}>
              {n.e164}
              {n.label ? ` — ${n.label}` : ""}
              {n.personal ? " (verified personal)" : ""}
            </option>
          ))}
        </select>
      )}

      {vapiPersonalUnsupported && (
        <div className="border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-300">
          ⚠ This account uses the Vapi engine. Vapi can only dial out from numbers
          it manages, so a verified personal caller ID won't show on the actual
          call — Vapi falls back to its own number. Switch this account's engine
          to DIY (jambonz) to honour the personal caller ID, or import the
          number into Vapi as a BYO Twilio number instead.
        </div>
      )}

      {/* Personal verified caller ID: list + add affordance */}
      <div className="border border-border p-3 space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">Your personal numbers</p>
            <p className="text-xs text-muted-foreground">
              Verified via Twilio so the recipient sees your real cell when the
              assistant calls.
            </p>
          </div>
          {!adding && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setAdding(true);
                setVerifyError(null);
              }}
              disabled={!twilioConfigured}
              title={twilioConfigured ? undefined : "Add Twilio Account SID + Auth Token to the phone-tools account first."}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add my number
            </Button>
          )}
        </div>

        {!twilioConfigured && (
          <p className="text-xs text-muted-foreground">
            Add a Twilio Account SID + Auth Token to this phone-tools account
            on the plugin settings page to enable personal-number verification.
          </p>
        )}

        {numbers.filter((n) => n.personal).length > 0 && (
          <ul className="text-xs divide-y divide-border">
            {numbers
              .filter((n) => n.personal)
              .map((n) => {
                const sid = n.id.replace(/^personal:/, "");
                return (
                  <li key={n.id} className="flex items-center justify-between py-1.5">
                    <span>
                      <span className="font-mono">{n.e164}</span>
                      {n.label && <span className="text-muted-foreground"> — {n.label}</span>}
                    </span>
                    <button
                      type="button"
                      onClick={() => deletePersonal(sid)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                      title="Remove from Twilio + local cache"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
          </ul>
        )}

        {adding && !pending && (
          <div className="space-y-2 pt-1">
            <input
              type="tel"
              inputMode="tel"
              value={personalE164}
              onChange={(e) => setPersonalE164(e.target.value)}
              placeholder="+17175771023"
              className="w-full border border-border bg-transparent px-2.5 py-1.5 text-sm focus:outline-none focus:border-foreground/40"
            />
            <input
              type="text"
              value={personalLabel}
              onChange={(e) => setPersonalLabel(e.target.value)}
              placeholder="Label (optional) — e.g. My cell"
              className="w-full border border-border bg-transparent px-2.5 py-1.5 text-sm focus:outline-none focus:border-foreground/40"
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={startVerification}
                disabled={!personalE164.trim()}
              >
                Send verification call
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAdding(false);
                  setPersonalE164("");
                  setPersonalLabel("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {pending && (
          <div className="border border-border bg-accent/30 p-2.5 text-xs space-y-2">
            <p>
              Twilio is calling <span className="font-mono">{pending.e164}</span>{" "}
              now. When it asks, enter this code on your keypad:
            </p>
            <p className="text-2xl font-mono tracking-widest text-center py-1">
              {pending.validationCode}
            </p>
            <p>{pending.instructions}</p>
            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" onClick={refreshFromTwilio}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                I entered the code — refresh
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPending(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {verifyError && <p className="text-xs text-destructive">{verifyError}</p>}
      </div>
    </div>
  );
}

function Step8({
  answers,
  voiceLabel,
  callerIdLabel,
  preview,
  previewLoading,
  previewError,
  firstMessageOverride,
  onFirstMessageChange,
  operatorPhone,
  onOperatorPhoneChange,
  onSaveOperatorPhone,
  isSavingOperatorPhone,
  verifiedOperatorPhone,
  onTest,
}: {
  answers: {
    name: string;
    principal: string;
    type: AssistantType;
    phoneEnabled: boolean;
    emailEnabled: boolean;
    calendarEnabled: boolean;
  };
  voiceLabel: string;
  callerIdLabel: string;
  preview: ComposeResult | null;
  previewLoading: boolean;
  previewError: string | null;
  firstMessageOverride: string | null;
  onFirstMessageChange: (value: string | null) => void;
  operatorPhone: string;
  onOperatorPhoneChange: (v: string) => void;
  onSaveOperatorPhone: () => void;
  isSavingOperatorPhone: boolean;
  verifiedOperatorPhone: string | null;
  assistantId: string | null;
  assistantRouteRef: string | null;
  onTest: () => void;
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold">Review</h2>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <span className="text-muted-foreground">Name</span>
        <span>{answers.name}</span>
        <span className="text-muted-foreground">Helps</span>
        <span>{answers.principal}</span>
        <span className="text-muted-foreground">Type</span>
        <span>{answers.type === "ea" ? "Personal EA" : "Custom"}</span>
        <span className="text-muted-foreground">Capabilities</span>
        <span>
          {[
            answers.phoneEnabled ? "Phone" : null,
            answers.emailEnabled ? "Email" : null,
            answers.calendarEnabled ? "Calendar" : null,
          ]
            .filter(Boolean)
            .join(" · ") || "(none)"}
        </span>
        <span className="text-muted-foreground">Voice</span>
        <span>{voiceLabel}</span>
        <span className="text-muted-foreground">Caller ID</span>
        <span>{callerIdLabel}</span>
        <span className="text-muted-foreground">Daily cap</span>
        <span>$10.00</span>
      </div>

      <div className="border border-border p-3 text-sm space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium">First message</p>
          {firstMessageOverride !== null && preview && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
              onClick={() => onFirstMessageChange(null)}
            >
              Reset to default
            </button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          The first thing the assistant says when a call connects.
          {" "}<code className="text-[10px] bg-muted px-1 py-0.5 rounded">{"{the reason for call}"}</code>{" "}
          is auto-substituted at call time with the <code className="text-[10px] bg-muted px-1 py-0.5 rounded">reason</code> the calling agent passes — leave it as-is for dynamic per-call greetings. Edit only if you want a fixed greeting (e.g. for an agent that always calls about the same thing).
        </p>
        {previewLoading && <p className="text-muted-foreground">Composing…</p>}
        {previewError && <p className="text-destructive">{previewError}</p>}
        {preview && (
          <textarea
            value={firstMessageOverride ?? preview.firstMessage}
            onChange={(e) => onFirstMessageChange(e.target.value)}
            rows={3}
            className="w-full border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:border-foreground/40 font-mono"
          />
        )}
      </div>
      <details className="border border-border p-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground">View full system prompt</summary>
        {preview && (
          <pre className="mt-2 whitespace-pre-wrap text-xs">{preview.systemPrompt}</pre>
        )}
      </details>

      <div className="border border-border p-3 text-sm space-y-1">
        <p className="font-medium">Safety rules — always on</p>
        <p className="text-muted-foreground text-xs">
          Identity-claim resistance · PII refusal · Anti-injection · AI-honesty disclosure
        </p>
      </div>

      <div className="border border-border p-4 space-y-3">
        <p className="font-medium text-sm">📲 Test on your phone first</p>
        <p className="text-xs text-muted-foreground">
          We'll call this number when you tap Test. Saved across all your assistants.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="tel"
            inputMode="tel"
            value={operatorPhone}
            onChange={(e) => onOperatorPhoneChange(e.target.value)}
            placeholder="+15551234567"
            className="flex-1 border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:border-foreground/40"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={onSaveOperatorPhone}
            disabled={isSavingOperatorPhone || operatorPhone.trim() === (verifiedOperatorPhone ?? "")}
          >
            {isSavingOperatorPhone ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save number"}
          </Button>
        </div>
        <Button onClick={onTest} disabled={!operatorPhone.trim()} size="sm">
          <Phone className="h-3.5 w-3.5 mr-1.5" />
          Test on my phone
        </Button>
      </div>
    </div>
  );
}

// ---- Small primitives ------------------------------------------------------

function Card({
  title,
  subtitle,
  selected,
  onClick,
  recommended,
}: {
  title: string;
  subtitle: string;
  selected: boolean;
  onClick: () => void;
  recommended?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "text-left border bg-card p-4 transition-colors",
        selected ? "border-foreground" : "border-border hover:border-foreground/40",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="font-medium text-sm">{title}</div>
        {recommended && (
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Recommended
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{subtitle}</p>
    </button>
  );
}

function CheckRow({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      className="flex items-center gap-2 text-sm border border-border bg-transparent p-2 hover:bg-accent/30 transition-colors text-left"
    >
      <span className={cn(
        "flex items-center justify-center h-3.5 w-3.5 border border-border rounded-sm shrink-0",
        checked && "bg-foreground border-foreground",
      )}>
        {checked && <Check className="text-background h-3 w-3" />}
      </span>
      <span>{label}</span>
    </button>
  );
}

function CapabilityRow({
  icon: Icon,
  label,
  subtitle,
  available,
  checked,
  onChange,
}: {
  icon: typeof Phone;
  label: string;
  subtitle: string;
  available: boolean;
  checked?: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 border border-border p-3 transition-colors",
        available && "bg-card",
        !available && "opacity-50",
      )}
    >
      <div className="mt-0.5">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex-1">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{label}</span>
          {available ? (
            <span className="text-[10px] uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
              Available
            </span>
          ) : (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Coming soon
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
      </div>
      {available && onChange ? (
        <button
          type="button"
          onClick={() => onChange(!checked)}
          className={cn(
            "flex items-center justify-center h-4 w-4 border border-border rounded-sm shrink-0 mt-0.5",
            checked && "bg-foreground border-foreground",
          )}
        >
          {checked && <Check className="text-background h-3 w-3" />}
        </button>
      ) : (
        <span className="h-4 w-4 shrink-0 mt-0.5" />
      )}
    </div>
  );
}
