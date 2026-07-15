import type {
  CalendarEvent,
  CalendarEventDetail,
  CalendarOccurrence,
  Company,
  CreateCalendarEvent,
  UpdateCalendarEvent,
} from "@paperclipai/shared";
import { api } from "./client";

export interface CalendarEventsResponse {
  events: CalendarEvent[];
}

export interface PortfolioEventsResponse {
  events: CalendarEvent[];
  companies: Company[];
}

export interface CalendarOccurrencesResponse {
  occurrences: CalendarOccurrence[];
}

export interface PortfolioCalendarResponse {
  occurrences: CalendarOccurrence[];
  companies: Company[];
}

export interface PortfolioEventsFilters {
  companyIds?: string[];
  status?: string[];
  kinds?: string[];
}

export const calendarApi = {
  listEvents: (companyId: string) =>
    api.get<CalendarEventsResponse>(`/companies/${companyId}/events`),

  listPortfolioEvents: (companyId: string, params?: PortfolioEventsFilters) => {
    const qs = new URLSearchParams();
    if (params?.companyIds?.length) qs.set("companyIds", params.companyIds.join(","));
    if (params?.status?.length) qs.set("status", params.status.join(","));
    if (params?.kinds?.length) qs.set("kinds", params.kinds.join(","));
    const query = qs.toString();
    return api.get<PortfolioEventsResponse>(
      `/companies/${companyId}/portfolio-events${query ? `?${query}` : ""}`,
    );
  },

  getCalendar: (companyId: string, from: string, to: string, kinds?: string[]) => {
    const qs = new URLSearchParams({ from, to });
    if (kinds?.length) qs.set("kinds", kinds.join(","));
    return api.get<CalendarOccurrencesResponse>(
      `/companies/${companyId}/calendar?${qs.toString()}`,
    );
  },

  getPortfolioCalendar: (companyId: string, from: string, to: string) => {
    const qs = new URLSearchParams({ from, to });
    return api.get<PortfolioCalendarResponse>(
      `/companies/${companyId}/portfolio-calendar?${qs.toString()}`,
    );
  },

  createEvent: (companyId: string, body: CreateCalendarEvent) =>
    api.post<CalendarEvent>(`/companies/${companyId}/events`, body),

  getEvent: (id: string) => api.get<CalendarEventDetail>(`/events/${id}`),

  updateEvent: (id: string, patch: UpdateCalendarEvent) =>
    api.patch<CalendarEvent>(`/events/${id}`, patch),

  deleteEvent: (id: string) => api.delete<void>(`/events/${id}`),

  fireEvent: (id: string) => api.post<{ ok: true }>(`/events/${id}/fire`, {}),
};
