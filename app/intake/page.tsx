"use client";

import { useEffect, useState } from "react";

type SubmitState = "idle" | "submitting" | "success" | "error";

interface FormData {
  title: string;
  description: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
}

const EMPTY_FORM: FormData = {
  title: "",
  description: "",
  customerName: "",
  customerEmail: "",
  customerPhone: "",
};

// TTB-1 Task 8 Phase 1B — allowed customerScope values that the upstream
// caller (connie.plus's "Create New Ticket" button) may pass via
// ?customerScope=. Anything else is ignored; the bridge falls back to its
// referer-based rule (today's behavior). Mirrors deployments/connie/config.json
// customerScopes[].scope values.
const ALLOWED_CUSTOMER_SCOPES = new Set(["NSS", "HHOVV", "Lifeline"]);

export default function IntakePage() {
  const [formData, setFormData] = useState<FormData>(EMPTY_FORM);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fallbackEmail, setFallbackEmail] = useState<string | null>(null);
  // Captured from URL on mount; forwarded through form submission body so
  // /api/intake can override its referer-based rule when the upstream knows
  // which child Flex domain spawned this intake.
  const [customerScope, setCustomerScope] = useState<string | null>(null);
  // TTB-19 / S3 B2.4: prefill_name + prefill_email arrive on the URL when
  // connie.plus's broker (B2.3) detects worker.full_name / worker.email from
  // the Flex template injection (basecamp display_url_when_no_tasks, B2.2).
  // Captured here on mount so resetForm can re-apply them after a successful
  // submit (agent files multiple tickets without retyping identity).
  const [prefill, setPrefill] = useState<{ name?: string; email?: string }>({});

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URL(window.location.href).searchParams;
    const scopeParam = params.get("customerScope");
    if (scopeParam && ALLOWED_CUSTOMER_SCOPES.has(scopeParam)) {
      setCustomerScope(scopeParam);
    }
    const prefillName = params.get("prefill_name") ?? undefined;
    const prefillEmail = params.get("prefill_email") ?? undefined;
    if (prefillName || prefillEmail) {
      setPrefill({ name: prefillName, email: prefillEmail });
      setFormData((prev) => ({
        ...prev,
        customerName: prefillName ?? prev.customerName,
        customerEmail: prefillEmail ?? prev.customerEmail,
      }));
    }
  }, []);

  const updateField = (field: keyof FormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const resetForm = () => {
    setFormData({
      ...EMPTY_FORM,
      customerName: prefill.name ?? "",
      customerEmail: prefill.email ?? "",
    });
    setSubmitState("idle");
    setTicketId(null);
    setErrorMessage(null);
    setFallbackEmail(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitState("submitting");
    setErrorMessage(null);
    setFallbackEmail(null);

    try {
      // Phase 1B: forward customerScope (from URL) when present. /api/intake
      // accepts it as a soft override of the referer-based rule.
      const submitBody = customerScope ? { ...formData, customerScope } : formData;
      const response = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submitBody),
      });
      const data = await response.json().catch(() => ({}));

      if (data?.ok) {
        setTicketId(String(data.ticketId ?? ""));
        setSubmitState("success");
      } else {
        setErrorMessage(
          typeof data?.errorMessage === "string"
            ? data.errorMessage
            : "Something went wrong. Please try again.",
        );
        if (typeof data?.fallbackEmail === "string") {
          setFallbackEmail(data.fallbackEmail);
        }
        setSubmitState("error");
      }
    } catch {
      setErrorMessage("Network error. Please check your connection.");
      setSubmitState("error");
    }
  };

  const isSubmitting = submitState === "submitting";

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
          <h1 className="text-3xl font-bold text-gray-800">TroubleTracker</h1>
          <p className="text-gray-600 mt-1">Submit a support ticket</p>
        </div>

        {submitState === "success" ? (
          <div className="bg-white rounded-lg shadow-sm p-6">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
              <p className="text-green-800 font-medium">
                Ticket #{ticketId} submitted successfully. We&apos;ll be in touch soon.
              </p>
            </div>
            <button
              onClick={resetForm}
              className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-6 py-3 rounded-lg transition-colors"
            >
              File another ticket
            </button>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="bg-white rounded-lg shadow-sm p-6 space-y-4"
          >
            {submitState === "error" && errorMessage && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="text-red-800">{errorMessage}</p>
                {fallbackEmail && (
                  <p className="text-red-700 text-sm mt-2">
                    Email us directly at{" "}
                    <a
                      href={`mailto:${fallbackEmail}`}
                      className="underline font-medium"
                    >
                      {fallbackEmail}
                    </a>
                  </p>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                What&apos;s the issue?
              </label>
              <input
                type="text"
                required
                value={formData.title}
                onChange={(e) => updateField("title", e.target.value)}
                disabled={isSubmitting}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 placeholder-gray-400 disabled:bg-gray-100"
                placeholder="Brief summary"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tell us more
              </label>
              <textarea
                required
                value={formData.description}
                onChange={(e) => updateField("description", e.target.value)}
                disabled={isSubmitting}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 placeholder-gray-400 h-32 disabled:bg-gray-100"
                placeholder="What happened? What did you expect?"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Your name
              </label>
              <input
                type="text"
                required
                value={formData.customerName}
                onChange={(e) => updateField("customerName", e.target.value)}
                disabled={isSubmitting}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 placeholder-gray-400 disabled:bg-gray-100"
                placeholder="Jane Smith"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Your email
              </label>
              <input
                type="email"
                required
                value={formData.customerEmail}
                onChange={(e) => updateField("customerEmail", e.target.value)}
                disabled={isSubmitting}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 placeholder-gray-400 disabled:bg-gray-100"
                placeholder="jane@example.com"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Your phone
              </label>
              <input
                type="tel"
                required
                value={formData.customerPhone}
                onChange={(e) => updateField("customerPhone", e.target.value)}
                disabled={isSubmitting}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 placeholder-gray-400 disabled:bg-gray-100"
                placeholder="(555) 123-4567"
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium px-6 py-3 rounded-lg transition-colors flex items-center justify-center"
            >
              {isSubmitting ? (
                <>
                  <svg
                    className="animate-spin -ml-1 mr-2 h-4 w-4 text-white"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  Submitting…
                </>
              ) : (
                "Submit Ticket"
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
