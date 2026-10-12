import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  Plus,
  Trash2,
  Pencil,
  BookUser,
  Loader2,
  X,
  Check,
  Mail,
  User,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import type { EmailToolsApi, EmailContact } from "../../api/emailTools";

export interface AddressBookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  emailApi: EmailToolsApi | null;
  companyId?: string | null;
  companyIds?: string[];
  companyName?: string;
  onSelectContact?: (contact: EmailContact) => void;
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

export function AddressBookDialog({
  open,
  onOpenChange,
  emailApi,
  companyId,
  companyIds,
  companyName,
  onSelectContact,
}: AddressBookDialogProps) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formEmail, setFormEmail] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const queryKey = useMemo(
    () => ["email-contacts", companyId, companyIds, search],
    [companyId, companyIds, search],
  );

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      if (!emailApi) return { contacts: [] };
      return emailApi.listContacts({
        query: search.trim() || undefined,
        companyIds: companyIds && companyIds.length > 0 ? companyIds : undefined,
      });
    },
    enabled: open && Boolean(emailApi),
  });

  const contacts = data?.contacts ?? [];

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!emailApi) throw new Error("Email API not available");
      return emailApi.saveContact({
        name: formName.trim() || undefined,
        email: formEmail.trim(),
        notes: formNotes.trim() || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-contacts"] });
      resetForm();
    },
    onError: (err) => {
      setFormError((err as Error).message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!emailApi) throw new Error("Email API not available");
      return emailApi.deleteContact(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-contacts"] });
      setDeleteConfirmId(null);
    },
  });

  function resetForm() {
    setIsEditing(false);
    setEditingId(null);
    setFormName("");
    setFormEmail("");
    setFormNotes("");
    setFormError(null);
  }

  function startCreate() {
    resetForm();
    setIsEditing(true);
  }

  function startEdit(contact: EmailContact) {
    setIsEditing(true);
    setEditingId(contact.id);
    setFormName(contact.name ?? "");
    setFormEmail(contact.email);
    setFormNotes(contact.notes ?? "");
    setFormError(null);
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const email = formEmail.trim();
    if (!email || !email.includes("@")) {
      setFormError("Please enter a valid email address");
      return;
    }
    setFormError(null);
    saveMutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[90vw] max-w-2xl flex-col gap-0 p-0 overflow-hidden sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <BookUser className="h-5 w-5 text-primary" />
              <div>
                <DialogTitle className="text-base font-semibold">Address Book</DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground">
                  {companyName ? `Contacts for ${companyName}` : "Manage saved contacts and email recipients"}
                </DialogDescription>
              </div>
            </div>
            {!isEditing && (
              <Button size="sm" onClick={startCreate} className="h-8 gap-1.5 text-xs">
                <Plus className="h-3.5 w-3.5" />
                Add Contact
              </Button>
            )}
          </div>
        </DialogHeader>

        {isEditing ? (
          <form onSubmit={handleSave} className="flex flex-col gap-4 p-5">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <h3 className="text-sm font-semibold">
                {editingId ? "Edit Contact" : "New Contact"}
              </h3>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={resetForm}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {formError && (
              <div className="rounded-md bg-destructive/15 p-2.5 text-xs text-destructive">
                {formError}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Email Address *
                </label>
                <div className="relative">
                  <Mail className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    type="email"
                    required
                    value={formEmail}
                    onChange={(e) => setFormEmail(e.target.value)}
                    placeholder="colleague@example.com"
                    className="h-8 pl-8 text-xs"
                    disabled={Boolean(editingId)} // email is key
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Full Name
                </label>
                <div className="relative">
                  <User className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    type="text"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="Christine Smith"
                    className="h-8 pl-8 text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Notes
                </label>
                <Textarea
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  placeholder="Role, organization, phone number, etc."
                  className="min-h-[80px] text-xs resize-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={resetForm}
                disabled={saveMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                className="h-8 text-xs gap-1.5"
                disabled={saveMutation.isPending}
              >
                {saveMutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                {editingId ? "Save Changes" : "Create Contact"}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col flex-1 min-h-0">
            {/* Search filter bar */}
            <div className="border-b border-border p-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search contacts by name or email..."
                  className="h-8 pl-8 text-xs"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Contact list */}
            <div className="flex-1 overflow-y-auto p-3">
              {isLoading ? (
                <div className="flex items-center justify-center p-8 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" />
                  <span className="text-xs">Loading contacts...</span>
                </div>
              ) : contacts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                  <BookUser className="h-8 w-8 stroke-1 mb-2 text-muted-foreground/60" />
                  <p className="text-xs font-medium">
                    {search ? "No contacts match your search." : "No contacts in address book yet."}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {search ? "Try searching for another name or email." : "Add frequently emailed contacts for auto-suggestions."}
                  </p>
                  {!search && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={startCreate}
                      className="mt-3 h-7 text-xs gap-1"
                    >
                      <Plus className="h-3 w-3" />
                      Add your first contact
                    </Button>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {contacts.map((contact) => (
                    <div
                      key={contact.id}
                      className="group flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-card p-2.5 transition-colors hover:border-border hover:bg-accent/30"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                          {getInitials(contact.name, contact.email)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-xs font-medium text-foreground">
                              {contact.name || contact.email}
                            </span>
                          </div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {contact.email}
                          </div>
                          {contact.notes && (
                            <div className="truncate text-[10px] text-muted-foreground/80 mt-0.5 italic">
                              {contact.notes}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {onSelectContact && (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="h-7 text-xs px-2"
                            onClick={() => {
                              onSelectContact(contact);
                              onOpenChange(false);
                            }}
                          >
                            Select
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                          onClick={() => startEdit(contact)}
                          title="Edit contact"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        {deleteConfirmId === contact.id ? (
                          <div className="flex items-center gap-1">
                            <Button
                              variant="destructive"
                              size="sm"
                              className="h-7 px-2 text-[11px]"
                              onClick={() => deleteMutation.mutate(contact.id)}
                              disabled={deleteMutation.isPending}
                            >
                              {deleteMutation.isPending ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                "Delete"
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => setDeleteConfirmId(null)}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => setDeleteConfirmId(contact.id)}
                            title="Delete contact"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
