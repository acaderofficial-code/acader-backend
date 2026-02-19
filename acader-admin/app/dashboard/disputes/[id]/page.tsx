"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { apiUrl } from "@/lib/api";

type DisputeStatus = "open" | "under_review" | "resolved" | "rejected";
type DisputeResolution =
  | "release_to_student"
  | "refund_to_company"
  | "partial_refund"
  | null;

type Dispute = {
  id: string;
  payment_id: string;
  raised_by: string;
  reason: string;
  status: DisputeStatus;
  resolution: DisputeResolution;
  created_at: string;
  resolved_at?: string | null;
  email: string;
};

type Payment = {
  id: number;
  user_id: number;
  company_id: number | null;
  project_id: number | null;
  application_id: number | null;
  amount: number | string;
  provider: string | null;
  provider_ref: string | null;
  status: string;
  escrow: boolean;
  disputed: boolean;
  created_at: string;
  paid_at?: string | null;
  released_at?: string | null;
  refunded_at?: string | null;
};

type WebhookEvent = {
  id: string;
  provider: string;
  event_id: string;
  event_type: string;
  reference: string | null;
  received_at: string;
};

export default function DisputeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { authHeaders, isAuthenticated, isLoading: authLoading } = useAuth();
  const [dispute, setDispute] = useState<Dispute | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!isAuthenticated || !id) return;
    setLoading(true);

    try {
      const disputesRes = await fetch(apiUrl("/api/admin/disputes"), {
        headers: authHeaders(),
      });

      if (!disputesRes.ok) {
        const data = await disputesRes.json().catch(() => null);
        throw new Error(data?.message || "Failed to fetch disputes");
      }

      const disputes: Dispute[] = await disputesRes.json();
      const found = disputes.find((d) => String(d.id) === String(id));
      if (!found) {
        throw new Error("Dispute not found");
      }

      setDispute(found);

      const paymentRes = await fetch(apiUrl(`/api/payments/${found.payment_id}`), {
        headers: authHeaders(),
      });
      if (!paymentRes.ok) {
        const data = await paymentRes.json().catch(() => null);
        throw new Error(data?.message || "Failed to fetch payment");
      }
      const paymentData: Payment = await paymentRes.json();
      setPayment(paymentData);

      if (paymentData.provider_ref) {
        const webhookRes = await fetch(
          apiUrl(
            `/api/admin/webhooks?provider=paystack&reference=${encodeURIComponent(
              paymentData.provider_ref,
            )}&limit=20`,
          ),
          {
            headers: authHeaders(),
          },
        );
        if (webhookRes.ok) {
          const webhookData = await webhookRes.json();
          setWebhooks(webhookData.events ?? []);
        } else {
          setWebhooks([]);
        }
      } else {
        setWebhooks([]);
      }

      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load dispute";
      setError(message);
      setDispute(null);
      setPayment(null);
      setWebhooks([]);
    } finally {
      setLoading(false);
    }
  }, [authHeaders, id, isAuthenticated]);

  useEffect(() => {
    if (!authLoading) {
      if (isAuthenticated) {
        fetchData();
      } else {
        setLoading(false);
      }
    }
  }, [authLoading, fetchData, isAuthenticated]);

  const updateStatus = async (status: "under_review" | "rejected") => {
    if (!dispute) return;
    const key = `status-${status}`;
    setActionLoading(key);
    try {
      const res = await fetch(apiUrl(`/api/admin/disputes/${dispute.id}/status`), {
        method: "PATCH",
        headers: authHeaders({ json: true }),
        body: JSON.stringify({ status }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to update status");
      }

      await fetchData();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Action failed";
      alert(message);
    } finally {
      setActionLoading(null);
    }
  };

  const resolveDispute = async (
    resolution: "release_to_student" | "refund_to_company" | "partial_refund",
  ) => {
    if (!dispute) return;
    let partialAmount: number | undefined;

    if (resolution === "partial_refund") {
      const input = window.prompt("Enter partial refund amount (NGN):");
      if (!input) return;
      const parsed = Number(input);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        alert("Enter a valid positive amount.");
        return;
      }
      partialAmount = parsed;
    }

    const key = `resolve-${resolution}`;
    setActionLoading(key);
    try {
      const res = await fetch(apiUrl(`/api/admin/disputes/${dispute.id}/resolve`), {
        method: "PATCH",
        headers: authHeaders({ json: true }),
        body: JSON.stringify({
          resolution,
          ...(partialAmount ? { partial_amount: partialAmount } : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to resolve dispute");
      }

      await fetchData();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Action failed";
      alert(message);
    } finally {
      setActionLoading(null);
    }
  };

  if (authLoading) return <div className="p-10">Loading authentication...</div>;
  if (!isAuthenticated) return <div className="p-10">Please log in.</div>;
  if (loading) return <div className="p-10">Loading dispute...</div>;
  if (error) return <div className="p-10 text-red-500">{error}</div>;
  if (!dispute) return <div className="p-10">Dispute not found.</div>;

  const isActive = dispute.status === "open" || dispute.status === "under_review";

  return (
    <div className="container mx-auto py-10 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dispute #{dispute.id}</h1>
        <Link href="/dashboard/disputes" className="text-blue-600 hover:underline">
          Back to disputes
        </Link>
      </div>

      <section className="bg-white border rounded p-5 space-y-2">
        <h2 className="font-semibold">Dispute Details</h2>
        <p>
          <span className="text-gray-600">Payment:</span>{" "}
          <Link
            className="text-blue-600 hover:underline"
            href={`/dashboard/payments/${dispute.payment_id}`}
          >
            #{dispute.payment_id}
          </Link>
        </p>
        <p>
          <span className="text-gray-600">Raised by:</span> {dispute.email} (
          {dispute.raised_by})
        </p>
        <p>
          <span className="text-gray-600">Status:</span>{" "}
          <span className="font-medium">{dispute.status}</span>
        </p>
        <p>
          <span className="text-gray-600">Resolution:</span>{" "}
          {dispute.resolution ? dispute.resolution.replaceAll("_", " ") : "-"}
        </p>
        <p>
          <span className="text-gray-600">Reason:</span> {dispute.reason || "-"}
        </p>
        <p>
          <span className="text-gray-600">Created:</span>{" "}
          {new Date(dispute.created_at).toLocaleString()}
        </p>
        {dispute.resolved_at ? (
          <p>
            <span className="text-gray-600">Resolved:</span>{" "}
            {new Date(dispute.resolved_at).toLocaleString()}
          </p>
        ) : null}
      </section>

      {payment ? (
        <section className="bg-white border rounded p-5 space-y-2">
          <h2 className="font-semibold">Linked Payment</h2>
          <p>
            <span className="text-gray-600">Status:</span> {payment.status}
          </p>
          <p>
            <span className="text-gray-600">Disputed flag:</span>{" "}
            {payment.disputed ? "true" : "false"}
          </p>
          <p>
            <span className="text-gray-600">Escrow:</span>{" "}
            {payment.escrow ? "true" : "false"}
          </p>
          <p>
            <span className="text-gray-600">Amount:</span>{" "}
            {formatNaira(payment.amount)}
          </p>
          <p>
            <span className="text-gray-600">Provider ref:</span>{" "}
            {payment.provider_ref ?? "-"}
          </p>
        </section>
      ) : null}

      <section className="bg-white border rounded p-5 space-y-3">
        <h2 className="font-semibold">Resolution Actions</h2>
        {isActive ? (
          <div className="flex flex-wrap gap-2">
            {dispute.status === "open" ? (
              <button
                className="bg-indigo-600 text-white px-4 py-2 rounded disabled:opacity-50"
                onClick={() => updateStatus("under_review")}
                disabled={actionLoading === "status-under_review"}
              >
                {actionLoading === "status-under_review" ? "..." : "Mark under review"}
              </button>
            ) : null}
            <button
              className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
              onClick={() => resolveDispute("release_to_student")}
              disabled={actionLoading === "resolve-release_to_student"}
            >
              {actionLoading === "resolve-release_to_student"
                ? "..."
                : "Resolve: Release to student"}
            </button>
            <button
              className="bg-red-600 text-white px-4 py-2 rounded disabled:opacity-50"
              onClick={() => resolveDispute("refund_to_company")}
              disabled={actionLoading === "resolve-refund_to_company"}
            >
              {actionLoading === "resolve-refund_to_company"
                ? "..."
                : "Resolve: Refund to company"}
            </button>
            <button
              className="bg-orange-600 text-white px-4 py-2 rounded disabled:opacity-50"
              onClick={() => resolveDispute("partial_refund")}
              disabled={actionLoading === "resolve-partial_refund"}
            >
              {actionLoading === "resolve-partial_refund"
                ? "..."
                : "Resolve: Partial refund"}
            </button>
            <button
              className="bg-gray-600 text-white px-4 py-2 rounded disabled:opacity-50"
              onClick={() => updateStatus("rejected")}
              disabled={actionLoading === "status-rejected"}
            >
              {actionLoading === "status-rejected" ? "..." : "Reject dispute"}
            </button>
          </div>
        ) : (
          <p className="text-sm text-gray-600">
            Dispute is closed. No further actions available.
          </p>
        )}
      </section>

      <section className="bg-white border rounded p-5">
        <h2 className="font-semibold mb-2">Webhook Timeline (By Payment Reference)</h2>
        {webhooks.length === 0 ? (
          <p className="text-sm text-gray-600">No webhook events found.</p>
        ) : (
          <div className="space-y-2">
            {webhooks.map((event) => (
              <div key={event.id} className="border rounded p-3">
                <div className="text-sm font-medium">{event.event_type}</div>
                <div className="text-xs text-gray-600">
                  {new Date(event.received_at).toLocaleString()} • {event.event_id}
                </div>
                <div className="text-xs text-gray-600">
                  reference: {event.reference ?? "-"}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function formatNaira(value: string | number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `₦${num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
