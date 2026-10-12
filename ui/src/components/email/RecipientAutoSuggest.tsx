import {
  useState,
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
  useCallback,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { BookUser, Loader2 } from "lucide-react";
import { Input } from "../ui/input";
import { cn } from "../../lib/utils";
import type { EmailToolsApi, EmailContact } from "../../api/emailTools";
import { AddressBookDialog } from "./AddressBookDialog";

export interface DraftFieldHandle {
  getValue: () => string;
  setValue: (value: string) => void;
  focus: () => void;
}

export interface RecipientAutoSuggestProps {
  value?: string;
  onChange?: (value: string) => void;
  initialValue?: string;
  draftKey?: string | null;
  placeholder?: string;
  className?: string;
  onContentChange?: (hasContent: boolean) => void;
  emailApi?: EmailToolsApi | null;
  companyId?: string | null;
  companyIds?: string[];
  companyName?: string;
}

const DRAFT_DEBOUNCE_MS = 500;

function saveDraft(key: string, value: string) {
  try {
    if (!value.trim()) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // LocalStorage full or blocked
  }
}

function getInitials(name: string | null, email: string): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return parts[0].slice(0, 2).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

export const RecipientAutoSuggest = forwardRef<DraftFieldHandle, RecipientAutoSuggestProps>(
  function RecipientAutoSuggest(
    {
      value: controlledValue,
      onChange: controlledOnChange,
      initialValue = "",
      draftKey = null,
      placeholder = "recipient@example.com",
      className,
      onContentChange,
      emailApi,
      companyId,
      companyIds,
      companyName,
    },
    ref,
  ) {
    const isControlled = controlledValue !== undefined;
    const [internalValue, setInternalValue] = useState(initialValue);
    const currentValue = isControlled ? controlledValue : internalValue;

    const inputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const hadContentRef = useRef((isControlled ? controlledValue : initialValue).trim().length > 0);
    const onContentChangeRef = useRef(onContentChange);
    onContentChangeRef.current = onContentChange;

    const [activeToken, setActiveToken] = useState("");
    const [activeTokenRange, setActiveTokenRange] = useState<{ start: number; end: number }>({
      start: 0,
      end: 0,
    });
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [isAddressBookOpen, setIsAddressBookOpen] = useState(false);

    function reportContent(v: string) {
      const has = v.trim().length > 0;
      if (has !== hadContentRef.current) {
        hadContentRef.current = has;
        onContentChangeRef.current?.(has);
      }
    }

    const updateValue = useCallback(
      (newVal: string) => {
        if (!isControlled) {
          setInternalValue(newVal);
        }
        controlledOnChange?.(newVal);
        reportContent(newVal);
      },
      [isControlled, controlledOnChange],
    );

    useImperativeHandle(
      ref,
      () => ({
        getValue: () => currentValue,
        setValue: (v: string) => updateValue(v),
        focus: () => inputRef.current?.focus(),
      }),
      [currentValue, updateValue],
    );

    // Save draft for uncontrolled / draftKey mode
    useEffect(() => {
      if (!draftKey) return;
      const t = setTimeout(() => saveDraft(draftKey, currentValue), DRAFT_DEBOUNCE_MS);
      return () => clearTimeout(t);
    }, [currentValue, draftKey]);

    // Compute current token at cursor position
    function computeActiveToken() {
      const input = inputRef.current;
      if (!input) return;
      const cursorPos = input.selectionStart ?? currentValue.length;
      const left = currentValue.slice(0, cursorPos);
      const right = currentValue.slice(cursorPos);

      const lastComma = left.lastIndexOf(",");
      const nextComma = right.indexOf(",");

      const start = lastComma === -1 ? 0 : lastComma + 1;
      const end = nextComma === -1 ? currentValue.length : cursorPos + nextComma;

      const raw = currentValue.slice(start, end);
      const token = raw.trim();

      setActiveToken(token);
      setActiveTokenRange({ start, end });
      setSelectedIndex(0);

      if (token.length >= 1 && emailApi) {
        setIsMenuOpen(true);
      } else {
        setIsMenuOpen(false);
      }
    }

    // Query matching contacts
    const { data, isLoading } = useQuery({
      queryKey: ["email-contacts-suggest", companyId, companyIds, activeToken],
      queryFn: async () => {
        if (!emailApi || !activeToken) return { contacts: [] };
        return emailApi.listContacts({
          query: activeToken,
          limit: 6,
          companyIds: companyIds && companyIds.length > 0 ? companyIds : undefined,
        });
      },
      enabled: isMenuOpen && Boolean(emailApi) && activeToken.length >= 1,
      staleTime: 30_000,
      retry: 1,
    });

    const suggestions = data?.contacts ?? [];

    function selectContact(contact: EmailContact) {
      const replacement = contact.name
        ? `${contact.name} <${contact.email}>`
        : contact.email;

      const prefix = currentValue.slice(0, activeTokenRange.start);
      const suffix = currentValue.slice(activeTokenRange.end);

      let formattedPrefix = prefix;
      if (formattedPrefix.length > 0 && !formattedPrefix.endsWith(" ")) {
        formattedPrefix += " ";
      }

      let formattedSuffix = suffix.trimStart();
      if (!formattedSuffix.startsWith(",") && !formattedSuffix.startsWith(";")) {
        formattedSuffix = formattedSuffix ? `, ${formattedSuffix}` : ", ";
      } else {
        formattedSuffix = `${formattedSuffix} `;
      }

      const nextVal = `${formattedPrefix}${replacement}${formattedSuffix}`;
      updateValue(nextVal);
      setIsMenuOpen(false);

      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          const newPos = formattedPrefix.length + replacement.length + formattedSuffix.length;
          inputRef.current.setSelectionRange(newPos, newPos);
        }
      }, 0);
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
      if (!isMenuOpen || suggestions.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % suggestions.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (suggestions[selectedIndex]) {
          e.preventDefault();
          selectContact(suggestions[selectedIndex]);
        }
      } else if (e.key === "Escape") {
        setIsMenuOpen(false);
      }
    }

    // Close menu when clicking outside
    useEffect(() => {
      function handleClickOutside(event: MouseEvent) {
        if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
          setIsMenuOpen(false);
        }
      }
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    return (
      <div ref={containerRef} className="relative flex-1">
        <div className="relative flex items-center">
          <Input
            ref={inputRef}
            type="text"
            value={currentValue}
            placeholder={placeholder}
            className={cn("pr-7", className)}
            onChange={(e) => {
              updateValue(e.target.value);
              computeActiveToken();
            }}
            onFocus={() => computeActiveToken()}
            onKeyUp={(e) => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
                computeActiveToken();
              }
            }}
            onClick={() => computeActiveToken()}
            onKeyDown={handleKeyDown}
          />
          <div className="absolute right-1.5 flex items-center gap-1">
            {isLoading && isMenuOpen && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            )}
            {emailApi && (
              <button
                type="button"
                onClick={() => setIsAddressBookOpen(true)}
                className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted"
                title="Open Address Book"
              >
                <BookUser className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Suggestion Dropdown */}
        {isMenuOpen && suggestions.length > 0 && (
          <div className="absolute left-0 top-full z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Suggested Contacts
            </div>
            {suggestions.map((contact, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={contact.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-xs transition-colors",
                    isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectContact(contact);
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
                    {getInitials(contact.name, contact.email)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {contact.name && (
                        <span className="font-medium truncate">{contact.name}</span>
                      )}
                      <span className={cn("truncate", contact.name ? "text-muted-foreground text-[11px]" : "font-medium")}>
                        {contact.name ? `<${contact.email}>` : contact.email}
                      </span>
                    </div>
                    {contact.notes && (
                      <div className="text-[10px] text-muted-foreground/75 truncate italic">
                        {contact.notes}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Full Address Book Dialog */}
        <AddressBookDialog
          open={isAddressBookOpen}
          onOpenChange={setIsAddressBookOpen}
          emailApi={emailApi ?? null}
          companyId={companyId}
          companyIds={companyIds}
          companyName={companyName}
          onSelectContact={selectContact}
        />
      </div>
    );
  },
);
