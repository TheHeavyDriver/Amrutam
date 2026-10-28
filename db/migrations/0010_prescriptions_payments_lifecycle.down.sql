DROP TABLE IF EXISTS payment_webhook_events;
DROP TABLE IF EXISTS payment_refunds;
DROP FUNCTION IF EXISTS prevent_payment_ledger_mutation();

DROP INDEX IF EXISTS prescriptions_consultation_created_id_idx;
DROP INDEX IF EXISTS prescriptions_one_draft_idx;

DROP TABLE IF EXISTS prescription_documents;
DROP FUNCTION IF EXISTS prevent_prescription_document_mutation();
