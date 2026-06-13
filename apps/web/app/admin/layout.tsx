import { AdminSidebar } from "@/components/ui/admin-sidebar";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="dm-shell">
      <AdminSidebar />
      <section className="dm-workspace">{children}</section>
    </main>
  );
}
