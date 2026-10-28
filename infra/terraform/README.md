# Terraform — AWS data plane

This stack provisions the production data plane:

- VPC across 2–4 AZs with public NAT gateways and private subnets.
- Multi-AZ RDS PostgreSQL 16 with 35-day PITR, deletion protection, Performance Insights, KMS encryption, and CloudWatch alarms.
- Multi-AZ ElastiCache Redis 7 with at-rest/in-transit encryption and AUTH.
- KMS key, Secrets Manager JSON (`app_secret_arn`), and an encrypted S3 exports bucket with lifecycle.
- Security groups that allow application workloads to reach RDS/Redis.

## Usage

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # edit values
terraform init
terraform fmt -check
terraform validate
terraform plan -out=tfplan
terraform apply tfplan
```

Attach the output `app_security_group_id` to the EKS node group (or add the node group security group IDs to `additional_app_security_group_ids`). Configure the Kubernetes `ExternalSecret` to read `app_secret_arn` and expose the keys as the `amrutam-secrets` Secret. The JSON keys match `.env.example`.

## State and safety

The S3 backend is commented in `versions.tf`; configure a versioned, encrypted bucket with DynamoDB locking before shared use. RDS has deletion protection and a final snapshot. `terraform destroy` will fail until deletion protection is disabled intentionally. Store state and plan files securely; they can contain sensitive values.

## Cost/scale notes

RDS/ElastiCache instance sizes are variables; choose them from k6 and production metrics. Add read replicas and PgBouncer when read traffic/latency requires it. Cross-region backup copies are an operator policy decision; configure AWS Backup or RDS snapshot copy for the chosen DR region.
