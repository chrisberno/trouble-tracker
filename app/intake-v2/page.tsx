"use client";

// app/intake-v2/page.tsx
// Polish mock of /intake — separate route so the live /intake at
// app/intake/page.tsx is unmodified until v2 is approved + smoke-tested.
//
// Changes vs. /intake:
//  1. Header: "TroubleTracker" → "Connie Support" (no internal-name leak)
//  2. Scope badge ("Filing for: Lifeline") rendered when customerScope set
//  3. Connie brand blue (#0263E0) replaces generic Tailwind blue-600
//  4. Required asterisks on all 5 labels
//  5. Success copy adds email-confirmation reassurance
//  6. Two <h2> sections: "About the issue" / "How to reach you"
//  7. Personalized greeting using prefill.name first-name when present
//  8. autoFocus on first field (title)
//  9. Submit button label: "Submit Ticket" → "Send" (warmer)
// 10. Page metadata title via app/intake-v2/layout.tsx
//
// UNCHANGED vs. /intake (the "do not nuke" guarantee):
//   - URL-param prefill logic (prefill_name / prefill_email / customerScope)
//   - resetForm() prefill restoration
//   - handleSubmit body construction + POST /api/intake target
//   - All state machine semantics (idle | submitting | success | error)

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

const ALLOWED_CUSTOMER_SCOPES = new Set(["NSS", "HHOVV", "Lifeline"]);

const SCOPE_DISPLAY_LABEL: Record<string, string> = {
  NSS: "NSS",
  HHOVV: "HHOVV",
  Lifeline: "Lifeline",
};

function firstName(fullName: string | undefined): string | null {
  if (!fullName) return null;
  const trimmed = fullName.trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/)[0];
  return first || null;
}

export default function IntakeV2Page() {
  const [formData, setFormData] = useState<FormData>(EMPTY_FORM);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fallbackEmail, setFallbackEmail] = useState<string | null>(null);
  const [customerScope, setCustomerScope] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ name?: string; email?: string }>({});

  // ===== AUTOPOPULATE LOGIC — verbatim from /intake (DO NOT MODIFY) =====
  // Contract with connie.plus's B2.3 broker (TTB-19 / S3): prefill_name +
  // prefill_email arrive on URL when the Flex template injection runs.
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
  // ===== END AUTOPOPULATE LOGIC =====

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
  const greetingName = firstName(prefill.name);
  const scopeLabel = customerScope
    ? SCOPE_DISPLAY_LABEL[customerScope] ?? customerScope
    : null;

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
          <h1 className="text-3xl font-bold text-gray-800">Connie Support</h1>
          <p className="text-gray-600 mt-1">Submit a support ticket</p>
          {scopeLabel && (
            <div className="mt-3">
              <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-50 text-[#0263E0] border border-blue-200">
                Filing for: {scopeLabel}
              </span>
            </div>
          )}
        </div>

        {submitState === "success" ? (
          <div className="bg-white rounded-lg shadow-sm p-6">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
              <p className="text-green-800 font-medium">
                Ticket #{ticketId} submitted successfully.
              </p>
              <p className="text-green-700 text-sm mt-2">
                You&apos;ll get an email confirmation shortly. We&apos;ll be in
                touch.
              </p>
            </div>
            <button
              onClick={resetForm}
              className="bg-[#0263E0] hover:bg-[#0150B8] text-white font-medium px-6 py-3 rounded-lg transition-colors"
            >
              File another ticket
            </button>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="bg-white rounded-lg shadow-sm p-6 space-y-6"
          >
            <div className="border-b border-gray-100 pb-4">
              {greetingName ? (
                <p className="text-gray-700">
                  Hi <span className="font-semibold">{greetingName}</span> —
                  sorry you&apos;re running into trouble. Fill out the form
                  below and we&apos;ll help you figure it out.
                </p>
              ) : (
                <p className="text-gray-700">
                  Sorry you&apos;re running into trouble. Fill out the form
                  below and we&apos;ll help you figure it out.
                </p>
              )}
            </div>

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

            <section>
              <h2 className="text-lg font-semibold text-gray-800 mb-3">
                About the issue
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    What&apos;s the issue?{" "}
                    <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    autoFocus
                    value={formData.title}
                    onChange={(e) => updateField("title", e.target.value)}
                    disabled={isSubmitting}
                    className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0263E0] focus:border-transparent text-gray-900 placeholder-gray-400 disabled:bg-gray-100"
                    placeholder="Brief summary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Tell us more <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    required
                    value={formData.description}
                    onChange={(e) => updateField("description", e.target.value)}
                    disabled={isSubmitting}
                    className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0263E0] focus:border-transparent text-gray-900 placeholder-gray-400 h-32 disabled:bg-gray-100"
                    placeholder="What happened? What did you expect?"
                  />
                </div>
              </div>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-gray-800 mb-3">
                How to reach you
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Your name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.customerName}
                    onChange={(e) =>
                      updateField("customerName", e.target.value)
                    }
                    disabled={isSubmitting}
                    className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0263E0] focus:border-transparent text-gray-900 placeholder-gray-400 disabled:bg-gray-100"
                    placeholder="Jane Smith"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Your email <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="email"
                    required
                    value={formData.customerEmail}
                    onChange={(e) =>
                      updateField("customerEmail", e.target.value)
                    }
                    disabled={isSubmitting}
                    className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0263E0] focus:border-transparent text-gray-900 placeholder-gray-400 disabled:bg-gray-100"
                    placeholder="jane@example.com"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Your phone <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="tel"
                    required
                    value={formData.customerPhone}
                    onChange={(e) =>
                      updateField("customerPhone", e.target.value)
                    }
                    disabled={isSubmitting}
                    className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#0263E0] focus:border-transparent text-gray-900 placeholder-gray-400 disabled:bg-gray-100"
                    placeholder="(555) 123-4567"
                  />
                </div>
              </div>
            </section>

            <button
              type="submit"
              disabled={isSubmitting}
              className="bg-[#0263E0] hover:bg-[#0150B8] disabled:bg-gray-400 text-white font-medium px-6 py-3 rounded-lg transition-colors flex items-center justify-center"
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
                  Sending…
                </>
              ) : (
                "Send"
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
