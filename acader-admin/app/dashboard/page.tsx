"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { apiUrl } from "@/lib/api";

type DashboardStats = {
  totalUsers: number;
  totalPayments: number;
  totalVolume: number;
  openDisputes: number;
  pendingWithdrawals: number;
};

export default function Dashboard() {
  const { authHeaders, isAuthenticated, isLoading: authLoading } = useAuth();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    if (!isAuthenticated) return;

    try {
      const res = await fetch(apiUrl("/api/admin/stats"), {
        headers: authHeaders(),
      });

      if (!res.ok) {
        throw new Error("Failed to fetch stats");
      }

      const data = await res.json();
      setStats(data);
    } catch (err) {
      console.error("Error fetching stats:", err);
      setError("Failed to load dashboard stats");
    } finally {
      setLoading(false);
    }
  }, [authHeaders, isAuthenticated]);

  useEffect(() => {
    if (!authLoading) {
      if (isAuthenticated) {
        fetchStats();
      } else {
        setLoading(false);
      }
    }
  }, [authLoading, isAuthenticated, fetchStats]);

  if (authLoading) return <div className="p-10">Loading...</div>;
  if (!isAuthenticated)
    return <div className="p-10">Please log in to view dashboard.</div>;

  return (
    <div>
      <h1 className="text-3xl font-bold mb-8">Admin Dashboard</h1>

      {loading ? (
        <p>Loading stats...</p>
      ) : error ? (
        <p className="text-red-500">{error}</p>
      ) : stats ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <StatCard title="Total Users" value={stats.totalUsers} />
          <StatCard title="Total Payments" value={stats.totalPayments} />
          <StatCard
            title="Total Volume"
            value={`₦${stats.totalVolume.toLocaleString()}`}
            className="bg-blue-50 border-blue-200"
          />
          <StatCard
            title="Open Disputes"
            value={stats.openDisputes}
            className={stats.openDisputes > 0 ? "bg-red-50 border-red-200" : ""}
          />
          <StatCard
            title="Pending Withdrawals"
            value={stats.pendingWithdrawals}
            className={
              stats.pendingWithdrawals > 0
                ? "bg-yellow-50 border-yellow-200"
                : ""
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function StatCard({
  title,
  value,
  className = "",
}: {
  title: string;
  value: string | number;
  className?: string;
}) {
  return (
    <div className={`bg-white p-6 rounded-lg shadow border ${className}`}>
      <h3 className="text-gray-500 text-sm font-medium uppercase tracking-wider mb-2">
        {title}
      </h3>
      <p className="text-3xl font-bold text-gray-900">{value}</p>
    </div>
  );
}
