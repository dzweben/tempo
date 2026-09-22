import DashboardShell from "@/components/DashboardShell";
import { CohortProvider } from "@/lib/cohort";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <CohortProvider>
      <DashboardShell>{children}</DashboardShell>
    </CohortProvider>
  );
}
