output "cloudfront_domain" {
  value = aws_cloudfront_distribution.frontend.domain_name
}

output "app_url" {
  value = "https://${var.domain_name}"
}

output "s3_bucket_name" {
  value = aws_s3_bucket.frontend.id
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.frontend.id
}

output "github_actions_role_arn" {
  value = aws_iam_role.github_actions.arn
}

output "codepipeline_name" {
  value = aws_codepipeline.dotrace.name
}
