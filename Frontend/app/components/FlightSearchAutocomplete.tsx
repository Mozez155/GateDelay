"use client";
import { useState, useEffect, useRef, useCallback, useId } from "react";

interface FlightSuggestion {
  flight_number: string;
  airline: string;
  departure: string;
  arrival: string;
}

interface Props {
  onSelect?: (flight: FlightSuggestion) => void;
  placeholder?: string;
}

type ErrorType = "timeout" | "rate_limit" | "api_key" | "network" | "provider" | "provider_format" | null;

// Debounce helper with a cancel() method so the caller can prevent a queued
// invocation from firing after unmount. (#1184)
interface Debounced<T extends (...args: Parameters<T>) => void> {
  (...args: Parameters<T>): void;
  cancel(): void;
}

function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  ms: number,
): Debounced<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const debounced = (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };

  debounced.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  return debounced as Debounced<T>;
}

const FETCH_TIMEOUT_MS = 8000;

function getErrorMessage(type: ErrorType): string {
  switch (type) {
    case "timeout":
      return "Search timed out. Check your connection or enter the flight number manually.";
    case "rate_limit":
      return "Too many requests — wait a moment, then try again.";
    case "api_key":
      return "Flight search is not configured. Enter the flight number manually.";
    case "network":
      return "Network error. Check your connection or enter the flight number manually.";
    case "provider":
      return "Flight data provider error. Try again or enter the flight number manually.";
    case "provider_format":
      return "Flight data provider returned an unexpected response. Try again or enter the flight number manually.";
    default:
      return "";
  }
}

// Runtime validation of a single flight record from the provider. (#1186)
// Returns a normalized suggestion or null when the record is malformed.
function parseFlightRecord(raw: unknown): FlightSuggestion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const f = raw as Record<string, unknown>;

  const flight = f.flight;
  if (typeof flight !== "object" || flight === null) return null;
  const flightNumber = (flight as Record<string, unknown>).iata;
  if (typeof flightNumber !== "string" || flightNumber.trim() === "") return null;

  const readIata = (value: unknown): string => {
    if (typeof value !== "object" || value === null) return "";
    const iata = (value as Record<string, unknown>).iata;
    return typeof iata === "string" ? iata : "";
  };

  const airline = f.airline;
  const airlineName =
    typeof airline === "object" && airline !== null &&
    typeof (airline as Record<string, unknown>).name === "string"
      ? ((airline as Record<string, unknown>).name as string)
      : "";

  return {
    flight_number: flightNumber,
    airline: airlineName,
    departure: readIata(f.departure),
    arrival: readIata(f.arrival),
  };
}

export default function FlightSearchAutocomplete({ onSelect, placeholder = "Search flights…" }: Props) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<FlightSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [open, setOpen] = useState(false);
  const [errorType, setErrorType] = useState<ErrorType>(null);
  const [noResults, setNoResults] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  // Per-instance IDs so multiple mounted widgets never collide. (#1185)
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  // Tracks a committed selection so the search effect does not re-open the
  // popup after the query is programmatically set. (#1187)
  const committedRef = useRef<string | null>(null);

  // Monotonically increasing counter used to discard stale responses. (#1183)
  // Each new fetch increments this; the response only updates state if its
  // captured id matches the current value when it resolves.
  const requestIdRef = useRef(0);

  const fetchSuggestions = useCallback(
    debounce(async (q: string) => {
      if (q.length < 2) {
        setSuggestions([]);
        setOpen(false);
        setErrorType(null);
        setNoResults(false);
        return;
      }

      // Capture and advance the request identity before any async work so
      // stale responses from earlier queries are silently discarded. (#1183)
      const requestId = ++requestIdRef.current;

      setLoading(true);
      setErrorType(null);
      setNoResults(false);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        // Proxy request — API key stays on the server. (#1182)
        const res = await fetch(
          `/api/flights/search?q=${encodeURIComponent(q)}`,
          { signal: controller.signal },
        );
        clearTimeout(timeoutId);

        // If a newer request has already started, discard this response. (#1183)
        if (requestId !== requestIdRef.current) return;

        if (res.status === 429) {
          setErrorType("rate_limit");
          setSuggestions([]);
          setOpen(false);
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { code?: string };
          if (body.code === "CONFIG_ERROR") {
            setErrorType("api_key");
          } else {
            setErrorType("provider");
          }
          setSuggestions([]);
          setOpen(false);
          return;
        }

        const data = await res.json().catch(() => null) as unknown;

        if (requestId !== requestIdRef.current) return;

        // Validate the envelope before touching .data. (#1186)
        if (typeof data !== "object" || data === null || !Array.isArray((data as { data?: unknown }).data)) {
          setErrorType("provider_format");
          setSuggestions([]);
          setOpen(false);
          return;
        }

        const rawRecords = (data as { data: unknown[] }).data;
        const results: FlightSuggestion[] = rawRecords
          .map(parseFlightRecord)
          .filter((f): f is FlightSuggestion => f !== null);

        // If the provider returned records but none were valid, surface a
        // format error rather than a misleading "no results". (#1186)
        if (results.length === 0 && rawRecords.length > 0) {
          setErrorType("provider_format");
          setSuggestions([]);
          setOpen(false);
          return;
        }

        setSuggestions(results);
        setNoResults(results.length === 0);
        setOpen(results.length > 0);
        setActiveIndex(-1);
      } catch (err) {
        clearTimeout(timeoutId);
        if (requestId !== requestIdRef.current) return;
        setErrorType((err as Error).name === "AbortError" ? "timeout" : "network");
        setSuggestions([]);
        setOpen(false);
      } finally {
        // Only clear the loading spinner if this is still the active request.
        if (requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    }, 350),
    [],
  );

  useEffect(() => {
    // While a selection is committed and the query still matches it, do not
    // search — this prevents the popup from reopening after selection. (#1187)
    if (committedRef.current !== null && query === committedRef.current) {
      fetchSuggestions.cancel();
      return;
    }
    fetchSuggestions(query);
    // Cancel any pending debounced invocation when the component unmounts or
    // before the next query fires, preventing post-teardown state updates. (#1184)
    return () => fetchSuggestions.cancel();
  }, [query, fetchSuggestions]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // A deliberate edit clears the committed selection so searching resumes.
    if (committedRef.current !== null && value !== committedRef.current) {
      committedRef.current = null;
    }
    setQuery(value);
  };

  const select = (flight: FlightSuggestion) => {
    // Invalidate any in-flight request so a late response cannot reopen the
    // popup after selection. (#1187)
    requestIdRef.current++;
    committedRef.current = flight.flight_number;
    setQuery(flight.flight_number);
    setOpen(false);
    setActiveIndex(-1);
    setErrorType(null);
    setNoResults(false);
    setLoading(false);
    onSelect?.(flight);
  };

  const useManualEntry = () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    requestIdRef.current++;
    committedRef.current = trimmed;
    setOpen(false);
    setActiveIndex(-1);
    setErrorType(null);
    setNoResults(false);
    setLoading(false);
    onSelect?.({ flight_number: trimmed, airline: "", departure: "", arrival: "" });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      select(suggestions[activeIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  const handleBlur = () => {
    setTimeout(() => {
      setOpen(false);
      setActiveIndex(-1);
    }, 150);
  };

  const showFeedback = !loading && query.length >= 2 && (errorType !== null || noResults);
  const isError = errorType !== null;

  return (
    <div className="relative w-full space-y-1.5">
      <div className="relative">
        <input
          type="text"
          role="combobox"
          value={query}
          onChange={handleChange}
          onKeyDown={onKeyDown}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onBlur={handleBlur}
          placeholder={placeholder}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-invalid={isError}
          className="w-full rounded-lg px-4 py-2.5 pr-10 text-sm outline-none focus:ring-2 focus:ring-blue-500"
          style={{
            background: "var(--card)",
            color: "var(--foreground)",
            border: `1px solid ${isError ? "rgba(239,68,68,0.5)" : "var(--border)"}`,
          }}
        />
        {loading && (
          <span
            aria-label="Searching…"
            className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"
          />
        )}
      </div>

      {showFeedback && (
        <div
          role={isError ? "alert" : "status"}
          className="rounded-lg px-3 py-2 text-xs flex items-start justify-between gap-2"
          style={{
            background: isError ? "rgba(239,68,68,0.06)" : "var(--card)",
            border: `1px solid ${isError ? "rgba(239,68,68,0.25)" : "var(--border)"}`,
            color: isError ? "#ef4444" : "var(--muted)",
          }}
        >
          <span>
            {noResults
              ? `No flights found for "${query}".`
              : getErrorMessage(errorType)}
          </span>
          {query.trim() && (
            <button
              type="button"
              onClick={useManualEntry}
              className="shrink-0 font-medium underline underline-offset-2 hover:opacity-80 transition-opacity whitespace-nowrap"
              style={{ color: isError ? "#ef4444" : "#3b82f6" }}
            >
              Use &ldquo;{query}&rdquo;
            </button>
          )}
        </div>
      )}

      {open && (
        <ul
          id={listboxId}
          role="listbox"
          ref={listRef}
          className="absolute z-50 mt-1 w-full rounded-lg shadow-lg overflow-hidden"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          {suggestions.map((f, i) => (
            <li
              key={f.flight_number + i}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              onMouseDown={() => select(f)}
              onMouseEnter={() => setActiveIndex(i)}
              className="flex items-center justify-between px-4 py-2.5 cursor-pointer text-sm transition-colors"
              style={{
                background: i === activeIndex ? "var(--border)" : "transparent",
                color: "var(--foreground)",
              }}
            >
              <span className="font-medium">{f.flight_number}</span>
              <span style={{ color: "var(--muted)" }} className="text-xs">
                {f.departure} → {f.arrival}
              </span>
              <span style={{ color: "var(--muted)" }} className="text-xs truncate max-w-[120px]">
                {f.airline}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
