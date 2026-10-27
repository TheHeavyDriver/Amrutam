DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS prescription_items;
DROP TABLE IF EXISTS prescriptions;

DROP FUNCTION IF EXISTS validate_payment_participants();
DROP FUNCTION IF EXISTS enforce_prescription_item_immutability();
DROP FUNCTION IF EXISTS enforce_prescription_immutability();
DROP FUNCTION IF EXISTS validate_prescription_participants();

DROP TYPE IF EXISTS payment_provider;
DROP TYPE IF EXISTS payment_status;
DROP TYPE IF EXISTS prescription_status;
