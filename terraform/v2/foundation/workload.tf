resource "aws_ecr_repository" "spine" {
  name                 = "${var.project}-spine"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  force_delete = true # spine is throwaway; replaced by the real image in P1d
}
