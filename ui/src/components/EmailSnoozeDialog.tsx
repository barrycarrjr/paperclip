import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  combineSnoozeDateTime,
  defaultCustomSnooze,
  isPastDay,
  monthGrid,
  toDateInputValue,
  toTimeInputValue,
} from "@/lib/email-snooze";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (until: Date) => void;
}

/** "Pick date & time": month calendar plus date and time fields, Cancel and Save. */
export function EmailSnoozeDialog({ open, onOpenChange, onSave }: Props) {
  const [dateValue, setDateValue] = useState("");
  const [timeValue, setTimeValue] = useState("");
  const [viewMonth, setViewMonth] = useState(() => new Date());

  // Start from tomorrow 8:00 AM each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const start = defaultCustomSnooze();
    setDateValue(toDateInputValue(start));
    setTimeValue(toTimeInputValue(start));
    setViewMonth(start);
  }, [open]);

  const now = new Date();
  const today = toDateInputValue(now);
  const chosen = combineSnoozeDateTime(dateValue, timeValue);
  const weeks = monthGrid(viewMonth.getFullYear(), viewMonth.getMonth());
  const monthLabel = viewMonth.toLocaleDateString([], { month: "long", year: "numeric" });
  const atCurrentMonth =
    viewMonth.getFullYear() === now.getFullYear() && viewMonth.getMonth() === now.getMonth();

  const shiftMonth = (delta: number) =>
    setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Pick date &amp; time</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="w-full sm:w-64" aria-label="Calendar">
            <div className="mb-2 flex items-center justify-between">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Previous month"
                disabled={atCurrentMonth}
                onClick={() => shiftMonth(-1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm font-medium">{monthLabel}</span>
              <Button size="icon-sm" variant="ghost" aria-label="Next month" onClick={() => shiftMonth(1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid grid-cols-7 gap-y-1 text-center text-xs">
              {WEEKDAYS.map((w, i) => (
                <div key={i} className="text-muted-foreground">{w}</div>
              ))}
              {weeks.flat().map((day, i) => {
                if (!day) return <div key={i} />;
                const value = toDateInputValue(day);
                const past = isPastDay(day, now);
                const selected = value === dateValue;
                const isToday = value === today;
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={past}
                    aria-pressed={selected}
                    aria-label={day.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
                    onClick={() => setDateValue(value)}
                    className={[
                      "mx-auto flex h-8 w-8 items-center justify-center rounded-full text-sm",
                      past ? "cursor-not-allowed text-muted-foreground/40" : "hover:bg-accent",
                      isToday && !selected ? "ring-1 ring-foreground/60" : "",
                      selected ? "bg-primary text-primary-foreground hover:bg-primary" : "",
                    ].join(" ")}
                  >
                    {day.getDate()}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Date
              <Input
                type="date"
                min={today}
                value={dateValue}
                onChange={(e) => {
                  setDateValue(e.target.value);
                  const d = combineSnoozeDateTime(e.target.value, "12:00");
                  if (d) setViewMonth(d);
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Time
              <Input type="time" value={timeValue} onChange={(e) => setTimeValue(e.target.value)} />
            </label>
            {!chosen && dateValue && timeValue && (
              <p className="text-xs text-destructive">Pick a time in the future.</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={!chosen}
            onClick={() => {
              if (!chosen) return;
              onSave(chosen);
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
