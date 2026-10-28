data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.availability_zone_count)
  tags = merge(
    {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
    },
    var.tags,
  )
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(local.tags, { Name = "${var.project}-${var.environment}-vpc" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.project}-${var.environment}-igw" })
}

resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false

  tags = merge(local.tags, {
    Name = "${var.project}-${var.environment}-public-${local.azs[count.index]}"
    Tier = "public"
  })
}

resource "aws_subnet" "private" {
  count = var.availability_zone_count

  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 1)
  availability_zone = local.azs[count.index]

  tags = merge(local.tags, {
    Name = "${var.project}-${var.environment}-private-${local.azs[count.index]}"
    Tier = "private"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = merge(local.tags, { Name = "${var.project}-${var.environment}-public" })
}

resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  count  = 2
  domain = "vpc"
  tags   = merge(local.tags, { Name = "${var.project}-${var.environment}-nat-${count.index}" })
}

resource "aws_nat_gateway" "this" {
  count = 2

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags       = merge(local.tags, { Name = "${var.project}-${var.environment}-nat-${count.index}" })
  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "private" {
  count = var.availability_zone_count

  vpc_id = aws_vpc.this.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[count.index % 2].id
  }

  tags = merge(local.tags, {
    Name = "${var.project}-${var.environment}-private-${local.azs[count.index]}"
  })
}

resource "aws_route_table_association" "private" {
  count = var.availability_zone_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# Application security group. Attach it (or the EKS node security group) to
# workloads that need to reach RDS and Redis.
resource "aws_security_group" "app" {
  name        = "${var.project}-${var.environment}-app"
  description = "Amrutam API and worker egress"
  vpc_id      = aws_vpc.this.id

  egress {
    description = "TLS, PostgreSQL, Redis, OTLP, and package endpoints via private subnets"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "${var.project}-${var.environment}-app" })
}

resource "aws_security_group" "data" {
  name        = "${var.project}-${var.environment}-data"
  description = "PostgreSQL and Redis ingress from application workloads"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "PostgreSQL from application security groups"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = concat([aws_security_group.app.id], var.additional_app_security_group_ids)
  }

  ingress {
    description     = "Redis from application security groups"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = concat([aws_security_group.app.id], var.additional_app_security_group_ids)
  }

  tags = merge(local.tags, { Name = "${var.project}-${var.environment}-data" })
}

resource "aws_db_subnet_group" "postgres" {
  name       = "${var.project}-${var.environment}-postgres"
  subnet_ids = aws_subnet.private[*].id
  tags       = local.tags
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.project}-${var.environment}-redis"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_kms_key" "data" {
  description             = "${var.project}-${var.environment} RDS, ElastiCache, and secrets encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  tags                    = local.tags
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.project}-${var.environment}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "random_password" "postgres" {
  length           = 32
  special          = true
  override_special = "-_.~"
}

resource "random_password" "redis" {
  length           = 32
  special          = true
  override_special = "-_.~"
}

resource "random_password" "jwt_access" {
  length           = 48
  special          = true
  override_special = "-_."
}

resource "random_password" "jwt_mfa" {
  length           = 48
  special          = true
  override_special = "-_."
}

resource "random_password" "token_pepper" {
  length           = 48
  special          = true
  override_special = "-_."
}

resource "random_password" "webhook" {
  length           = 48
  special          = true
  override_special = "-_."
}

resource "random_bytes" "encryption_key" {
  length = 32
}

resource "aws_db_instance" "postgres" {
  identifier = "${var.project}-${var.environment}-postgres"

  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.data.arn

  db_name  = "amrutam"
  username = "amrutam"
  password = random_password.postgres.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.postgres.name
  vpc_security_group_ids = [aws_security_group.data.id]
  publicly_accessible    = false
  multi_az               = true

  backup_retention_period         = 35
  backup_window                   = "18:00-19:00"
  maintenance_window              = "sun:19:00-sun:20:00"
  copy_tags_to_snapshot           = true
  delete_automated_backups        = false
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${var.project}-${var.environment}-final"
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.data.arn
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  auto_minor_version_upgrade      = false
  apply_immediately               = false

  tags = merge(local.tags, { Name = "${var.project}-${var.environment}-postgres" })
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${var.project}-${var.environment}-redis"
  description          = "Amrutam doctor cache and rate-limit backend"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.redis_node_type
  port           = 6379

  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.data.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result
  kms_key_id                 = aws_kms_key.data.arn

  snapshot_retention_limit = 7
  snapshot_window          = "17:00-18:00"
  maintenance_window       = "sun:18:00-sun:19:00"

  tags = merge(local.tags, { Name = "${var.project}-${var.environment}-redis" })
}

resource "random_id" "s3_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "exports" {
  bucket = "${var.project}-${var.environment}-exports-${random_id.s3_suffix.hex}"
  tags   = merge(local.tags, { Name = "${var.project}-${var.environment}-exports" })
}

resource "aws_s3_bucket_public_access_block" "exports" {
  bucket                  = aws_s3_bucket.exports.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "exports" {
  bucket = aws_s3_bucket.exports.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id
  rule {
    id     = "retain-and-archive"
    status = "Enabled"
    filter {}
    transition {
      days          = 90
      storage_class = "GLACIER"
    }
    expiration {
      days = 365
    }
  }
}

# One JSON secret is consumed by the Kubernetes ExternalSecret and projected
# into the amrutam-secrets Secret. Do not print it in CI logs.
resource "aws_secretsmanager_secret" "app" {
  name                    = "${var.project}/${var.environment}/app"
  description             = "Amrutam API and worker runtime secrets"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 7
  tags                    = local.tags
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    DATABASE_URL = format(
      "postgresql://%s:%s@%s:%s/%s",
      "amrutam",
      urlencode(random_password.postgres.result),
      aws_db_instance.postgres.address,
      aws_db_instance.postgres.port,
      "amrutam",
    )
    REDIS_URL              = format("rediss://:%s@%s:%s", urlencode(random_password.redis.result), aws_elasticache_replication_group.redis.primary_endpoint_address, 6379)
    JWT_ACCESS_SECRET      = random_password.jwt_access.result
    JWT_MFA_SECRET         = random_password.jwt_mfa.result
    AUTH_TOKEN_PEPPER      = random_password.token_pepper.result
    AUTH_ENCRYPTION_KEY    = random_bytes.encryption_key.base64
    PAYMENT_WEBHOOK_SECRET = random_password.webhook.result
  })
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.project}-${var.environment}-rds-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "RDS CPU above 80% for 15 minutes"
  alarm_actions       = var.alarm_sns_topic_arns
  ok_actions          = var.alarm_sns_topic_arns
  dimensions          = { DBInstanceIdentifier = aws_db_instance.postgres.identifier }
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${var.project}-${var.environment}-rds-storage"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 10737418240
  alarm_description   = "RDS free storage below 10 GiB"
  alarm_actions       = var.alarm_sns_topic_arns
  dimensions          = { DBInstanceIdentifier = aws_db_instance.postgres.identifier }
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "redis_cpu" {
  alarm_name          = "${var.project}-${var.environment}-redis-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "EngineCPUUtilization"
  namespace           = "AWS/ElastiCache"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Redis engine CPU above 80% for 15 minutes"
  alarm_actions       = var.alarm_sns_topic_arns
  dimensions          = { ReplicationGroupId = aws_elasticache_replication_group.redis.id }
  tags                = local.tags
}
