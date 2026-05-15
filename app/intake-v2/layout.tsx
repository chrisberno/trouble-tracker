import type { Metadata } from "next";

// /intake-v2 mock branding — separate route so the live /intake at
// app/intake/page.tsx is not touched until v2 is smoke-validated.
export const metadata: Metadata = {
  title: "Support — Connie",
  description: "Submit a support ticket",
};

export default function IntakeV2Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
