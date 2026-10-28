variable "aws_region" {
  description = "AWS region for the data plane."
  type        = string
  default     = "ap-south-1"
}

variable "project" {
  description = "Short project slug used in resource names."
  type        = string
  default     = "amrutam"
}

variable "environment" {
  description = "Deployment environment (staging, prod)."
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "vpc_cidr" {
  description = "VPC CIDR. Private /20 subnets are allocated per AZ."
  type        = string
  default     = "10.40.0.0/16"
}

variable "availability_zone_count" {
  description = "Number of AZs. Must be at least 2 for Multi-AZ data services."
  type        = number
  default     = 3

  validation {
    condition     = var.availability_zone_count >= 2 && var.availability_zone_count <= 4
    error_message = "Use 2 to 4 availability zones."
  }
}

variable "db_instance_class" {
  description = "RDS instance class. Size from load-test results."
  type        = string
  default     = "db.r6g.xlarge"
}

variable "db_allocated_storage_gb" {
  description = "Initial RDS gp3 storage."
  type        = number
  default     = 200
}

variable "db_max_allocated_storage_gb" {
  description = "RDS storage autoscaling ceiling."
  type        = number
  default     = 2000
}

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.r7g.large"
}

variable "additional_app_security_group_ids" {
  description = "Existing EKS node/application security groups allowed to reach RDS and Redis."
  type        = list(string)
  default     = []
}

variable "alarm_sns_topic_arns" {
  description = "Optional SNS topics for CloudWatch alarm notifications."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Additional resource tags."
  type        = map(string)
  default     = {}
}
