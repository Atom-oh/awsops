variable "onboard_eks_clusters" {
  type        = list(string)
  description = "Host-account EKS cluster names to grant the web task role read access (Access Entry). Written by `make configure`."
  default     = []
}

# Look up each onboarded cluster (validates existence + exposes endpoint/CA for P3 kubeconfig).
data "aws_eks_cluster" "onboard" {
  for_each = toset(var.onboard_eks_clusters)
  name     = each.value
}

# Access Entry: register the web task role as a STANDARD principal on each cluster.
resource "aws_eks_access_entry" "web" {
  for_each      = toset(var.onboard_eks_clusters)
  cluster_name  = each.value
  principal_arn = aws_iam_role.task.arn
  type          = "STANDARD"
}

# Bind the AWS-managed read-only View policy at cluster scope.
resource "aws_eks_access_policy_association" "web_view" {
  for_each      = toset(var.onboard_eks_clusters)
  cluster_name  = each.value
  principal_arn = aws_iam_role.task.arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy"
  access_scope {
    type = "cluster"
  }
  depends_on = [aws_eks_access_entry.web]
}

# IAM the web task role needs to discover clusters + build a kubeconfig (P3 consumes this).
resource "aws_iam_role_policy" "task_eks" {
  count = length(var.onboard_eks_clusters) > 0 ? 1 : 0
  name  = "${var.project}-task-eks-read"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["eks:DescribeCluster", "eks:ListClusters", "eks:DescribeAccessEntry"]
      Resource = "*"
    }]
  })
}

output "onboarded_eks_clusters" {
  description = "Onboarded EKS clusters -> endpoint/ARN (for P3 dashboard kubeconfig registration)."
  value = {
    for k, c in data.aws_eks_cluster.onboard : k => {
      endpoint                   = c.endpoint
      arn                        = c.arn
      certificate_authority_data = c.certificate_authority[0].data
    }
  }
}
