variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "dotrace-game"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "websocket_url" {
  type        = string
  description = "WebSocket URL from CDK output (wss://...)"
  default     = ""
}

variable "domain_name" {
  type    = string
  default = "dotrace.fpoiato.com"
}

variable "route53_zone_id" {
  type    = string
  default = "Z094351536ZBINA5SU45F"
}

variable "github_owner" {
  type    = string
  default = "fpoiato"
}

variable "github_repo" {
  type    = string
  default = "dotrace"
}

variable "github_branch" {
  type    = string
  default = "main"
}

variable "codestar_connection_name" {
  type    = string
  default = "testproject-github"
}

variable "tf_state_bucket" {
  type    = string
  default = "contact-game-terraform-state-986873053420"
}
