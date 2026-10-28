terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60.0, < 7.0.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Configure a remote backend before using this stack for shared environments.
  # backend "s3" {
  #   bucket         = "amrutam-terraform-state"
  #   key            = "prod/network-data/terraform.tfstate"
  #   region         = "ap-south-1"
  #   dynamodb_table = "amrutam-terraform-locks"
  #   encrypt        = true
  # }
}
