"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { apiUrl } from "@/lib/api";

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

type Dispute = {
  id: string;
  payment_id: string;
  status: string;
  resolution: string | null;
  reason: string | null;
  created_at: string;
};

type WebhookEvent = {
  id: string;
  provider: string;
  event_id: string;
  event_type: string;
  reference: string | null;
  received_at: string;
};

export default function PaymentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { authHeaders, isAuthenticated, isLoading: authLoading } = useAuth();
  const [payment, setPayment] = useState<Payment | null>(null);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!isAuthenticated || !id) return;
    setLoading(true);
    try {
      const paymentRes = await fetch(apiUrl(`/api/payments/${id}`), {
        headers: authHeaders(),
      });
      if (!paymentRes.ok) {
        const data = await paymentRes.json().catch(() => null);
        throw new Error(data?.message || "Failed to fetch payment");
      }

      const paymentData: Payment = await paymentRes.json();
      setPayment(paymentData);

      const disputesRes = await fetch(apiUrl("/api/admin/disputes"), {
        headers: authHeaders(),
      });
      if (disputesRes.ok) {
        const allDisputes: Dispute[] = await disputesRes.json();
        setDisputes(
          allDisputes.filter((d) => String(d.payment_id) === String(paymentData.id)),
        );
      } else {
        setDisputes([]);
      }

      if (paymentData.provider_ref) {
        const webhookRes = await fetch(
          apiUrl(
            `/api/admin/webhooks?provider=paystack&reference=${encodeURIComponent(
              paymentData.provider_ref,
            )}&limit=30`,
          ),
          { headers: authHeaders() },
        );
        if (webhookRes.ok) {
          const data = await webhookRes.json();
          setWebhooks(data.events ?? []);
        } else {
          setWebhooks([]);
        }
      } else {
        setWebhooks([]);
      }

      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load payment";
      setError(message);
      setPayment(null);
      setDisputes([]);
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

  const releasePayment = async () => {
    if (!payment) return;
    setActionLoading("release");
    try {
      const res = await fetch(apiUrl(`/api/payments/${payment.id}/status`), {
        method: "PATCH",
        headers: authHeaders({ json: true }),
        body: JSON.stringify({ status: "released" }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to release payment");
      }
      await fetchData();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Action failed";
      alert(message);
    } finally {
      setActionLoading(null);
    }
  };

  const refundPayment = async () => {
    if (!payment) return;
    setActionLoading("refund");
    try {
      const res = await fetch(apiUrl(`/api/payments/${payment.id}/refund`), {
        method: "POST",
        headers: authHeaders({ json: true }),
        body: JSON.stringify({ reason: "Admin refund from payment details" }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to refund payment");
      }
      await fetchData();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Action failed";
      alert(message);
    } finally {
      setActionLoading(null);
    }
  };

  const openDispute = async () => {
    if (!payment) return;
    setActionLoading("dispute");
    try {
      const res = await fetch(apiUrl(`/api/payments/${payment.id}/dispute`), {
        method: "POST",
        headers: authHeaders({ json: true }),
        body: JSON.stringify({ reason: "Admin opened dispute from payment details" }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to open dispute");
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
  if (loading) return <div className="p-10">Loading payment...</div>;
  if (error) return <div className="p-10 text-red-500">{error}</div>;
  if (!payment) return <div className="p-10">Payment not found.</div>;

  const canOperate = !payment.disputed;
  const canRelease = canOperate && payment.status === "paid";
  const canRefund = canOperate && (payment.status === "paid" || payment.status === "released");
  const canDispute = canOperate && (payment.status === "paid" || payment.status === "released");

  return (
    <div className="container mx-auto py-10 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Payment #{payment.id}</h1>
        <Link href="/dashboard/payments" className="text-blue-600 hover:underline">
          Back to payments
        </Link>
      </div>

      <section className="bg-white border rounded p-5 space-y-2">
        <h2 className="font-semibold">Payment Metadata</h2>
        <p>
          <span className="text-gray-600">User:</span> {payment.user_id}
        </p>
        <p>
          <span className="text-gray-600">Amount:</span> {formatNaira(payment.amount)}
        </p>
        <p>
          <span className="text-gray-600">Status:</span> {payment.status}
        </p>
        <p>
          <span className="text-gray-600">Disputed:</span>{" "}
          {payment.disputed ? "true" : "false"}
        </p>
        <p>
          <span className="text-gray-600">Escrow:</span> {payment.escrow ? "true" : "false"}
        </p>
        <p>
          <span className="text-gray-600">Provider:</span> {payment.provider ?? "-"}
        </p>
        <p>
          <span className="text-gray-600">Provider ref:</span> {payment.provider_ref ?? "-"}
        </p>
        <p>
          <span className="text-gray-600">Created:</span>{" "}
          {new Date(payment.created_at).toLocaleString()}
        </p>
        {payment.paid_at ? (
          <p>
            <span className="text-gray-600">Paid at:</span>{" "}
            {new Date(payment.paid_at).toLocaleString()}
          </p>
        ) : null}
        {payment.released_at ? (
          <p>
            <span className="text-gray-600">Released at:</span>{" "}
            {new Date(payment.released_at).toLocaleString()}
          </p>
        ) : null}
        {payment.refunded_at ? (
          <p>
            <span className="text-gray-600">Refunded at:</span>{" "}
            {new Date(payment.refunded_at).toLocaleString()}
          </p>
        ) : null}
      </section>

      <section className="bg-white border rounded p-5 space-y-3">
        <h2 className="font-semibold">Actions</h2>
        {!canOperate ? (
          <p className="text-sm text-red-700">
            This payment is under dispute. Direct payment actions are frozen.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
            onClick={releasePayment}
            disabled={!canRelease || actionLoading === "release"}
          >
            {actionLoading === "release" ? "..." : "Release"}
          </button>
          <button
            className="bg-red-600 text-white px-4 py-2 rounded disabled:opacity-50"
            onClick={refundPayment}
            disabled={!canRefund || actionLoading === "refund"}
          >
            {actionLoading === "refund" ? "..." : "Refund"}
          </button>
          <button
            className="bg-gray-700 text-white px-4 py-2 rounded disabled:opacity-50"
            onClick={openDispute}
            disabled={!canDispute || actionLoading === "dispute"}
          >
            {actionLoading === "dispute" ? "..." : "Open dispute"}
          </button>
        </div>
      </section>

      <section className="bg-white border rounded p-5">
        <h2 className="font-semibold mb-2">Disputes Linked to Payment</h2>
        {disputes.length === 0 ? (
          <p className="text-sm text-gray-600">No disputes found for this payment.</p>
        ) : (
          <div className="space-y-2">
            {disputes.map((d) => (
              <div key={d.id} className="border rounded p-3">
                <div className="flex items-center justify-between">
                  <div className="font-medium">Dispute #{d.id}</div>
                  <Link
                    href={`/dashboard/disputes/${d.id}`}
                    className="text-blue-600 hover:underline text-sm"
                  >
                    Open
                  </Link>
                </div>
                <div className="text-sm text-gray-700">
                  status: {d.status} | resolution: {d.resolution ?? "-"}
                </div>
                <div className="text-sm text-gray-700">reason: {d.reason ?? "-"}</div>
                <div className="text-xs text-gray-500">
                  created: {new Date(d.created_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="bg-white border rounded p-5">
        <h2 className="font-semibold mb-2">Webhook Timeline</h2>
        {webhooks.length === 0 ? (
          <p className="text-sm text-gray-600">No webhook events found.</p>
        ) : (
          <div className="space-y-2">
            {webhooks.map((event) => (
              <div key={event.id} className="border rounded p-3">
                <div className="font-medium">{event.event_type}</div>
                <div className="text-xs text-gray-600">
                  {new Date(event.received_at).toLocaleString()}
                </div>
                <div className="text-xs text-gray-600">event id: {event.event_id}</div>
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
