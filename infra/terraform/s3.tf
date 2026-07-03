resource "aws_s3_bucket" "frontend" {
  bucket = "${var.project_name}-${var.environment}-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_ssm_parameter" "websocket_url" {
  count = var.websocket_url != "" ? 1 : 0
  name  = "/${var.project_name}/${var.environment}/websocket_url"
  type  = "String"
  value = var.websocket_url
}

resource "aws_ssm_parameter" "app_url" {
  name  = "/${var.project_name}/${var.environment}/app_url"
  type  = "String"
  value = "https://${var.domain_name}"
}

resource "aws_ssm_parameter" "s3_bucket_name" {
  name  = "/${var.project_name}/${var.environment}/s3_bucket_name"
  type  = "String"
  value = aws_s3_bucket.frontend.id
}

resource "aws_ssm_parameter" "cloudfront_distribution_id" {
  name  = "/${var.project_name}/${var.environment}/cloudfront_distribution_id"
  type  = "String"
  value = aws_cloudfront_distribution.frontend.id
}
