output "vpc_id" {
  value = aws_vpc.this.id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "app_security_group_id" {
  description = "Attach this security group to EKS nodes/workloads that need RDS and Redis access."
  value       = aws_security_group.app.id
}

output "data_security_group_id" {
  value = aws_security_group.data.id
}

output "database_endpoint" {
  value     = aws_db_instance.postgres.address
  sensitive = false
}

output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "app_secret_arn" {
  description = "Secrets Manager JSON consumed by the Kubernetes ExternalSecret."
  value       = aws_secretsmanager_secret.app.arn
}

output "exports_bucket" {
  value = aws_s3_bucket.exports.bucket
}

output "kms_key_arn" {
  value = aws_kms_key.data.arn
}
