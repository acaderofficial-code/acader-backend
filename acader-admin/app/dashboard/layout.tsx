"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useAuth } from "@/contexts/AuthContext";
import { useRouter } from "next/navigation";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { logout, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated, isLoading, router]);

  const handleLogout = async () => {
    await logout();
    router.push("/login");
  };

  if (isLoading) {
    return <div className="p-10">Loading authentication...</div>;
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-64 bg-gray-900 text-white p-6 flex flex-col">
        <h2 className="text-xl font-bold mb-8">ACADER 👑</h2>

        <nav className="flex-1 flex flex-col space-y-2">
          <Link
            href="/dashboard"
            className="rounded px-3 py-2 hover:bg-gray-800"
          >
            Dashboard
          </Link>

          <Link
            href="/dashboard/users"
            className="rounded px-3 py-2 hover:bg-gray-800"
          >
            Users
          </Link>

          <Link
            href="/dashboard/payments"
            className="rounded px-3 py-2 hover:bg-gray-800"
          >
            Payments
          </Link>

          <Link
            href="/dashboard/disputes"
            className="rounded px-3 py-2 hover:bg-gray-800"
          >
            Disputes
          </Link>

          <Link
            href="/dashboard/withdrawals"
            className="rounded px-3 py-2 hover:bg-gray-800"
          >
            Withdrawals
          </Link>

          <Link
            href="/dashboard/ledger"
            className="rounded px-3 py-2 hover:bg-gray-800"
          >
            Ledger
          </Link>

          <Link
            href="/dashboard/reconciliation"
            className="rounded px-3 py-2 hover:bg-gray-800"
          >
            Reconciliation
          </Link>

          <Link
            href="/dashboard/settlements"
            className="rounded px-3 py-2 hover:bg-gray-800"
          >
            Settlements
          </Link>

          <Link
            href="/dashboard/fraud-reviews"
            className="rounded px-3 py-2 hover:bg-gray-800"
          >
            Fraud Reviews
          </Link>

          <Link
            href="/dashboard/risk-audit"
            className="rounded px-3 py-2 hover:bg-gray-800"
          >
            Risk Audit
          </Link>

          <Link
            href="/dashboard/financial-verify"
            className="rounded px-3 py-2 hover:bg-gray-800"
          >
            Financial Verify
          </Link>

          <Link
            href="/dashboard/webhooks"
            className="rounded px-3 py-2 hover:bg-gray-800"
          >
            Webhooks
          </Link>
        </nav>

        <button
          onClick={handleLogout}
          className="mt-auto w-full text-left rounded px-3 py-2 hover:bg-red-800 text-red-200"
        >
          Logout
        </button>
      </aside>

      {/* Main content */}
      <main className="flex-1 bg-gray-50 p-10">{children}</main>
    </div>
  );
}
