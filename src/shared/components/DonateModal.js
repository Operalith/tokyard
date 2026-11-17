"use client";
import Link from "next/link";
import Modal from "./Modal";
export default function DonateModal({ isOpen, onClose }) {
  return <Modal isOpen={isOpen} onClose={onClose} title="Support TokYard"><p className="mb-5 text-text-muted">Voluntary support helps maintain TokYard.</p><Link href="/dashboard/support" onClick={onClose} className="text-primary underline">Open support page</Link></Modal>;
}
