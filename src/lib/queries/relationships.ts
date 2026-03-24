export const queries = {
  // EC2 -> VPC, Subnet, SGs
  ec2Relations: `
    SELECT
      i.account_id,
      i.instance_id,
      i.instance_type,
      i.instance_state,
      i.vpc_id,
      i.subnet_id,
      i.private_ip_address,
      i.public_ip_address,
      tags ->> 'Name' AS name
    FROM aws_ec2_instance i
    ORDER BY i.vpc_id, i.subnet_id
  `,

  // VPC -> Subnets
  vpcSubnets: `
    SELECT
      v.account_id,
      v.vpc_id,
      v.cidr_block AS vpc_cidr,
      v.tags ->> 'Name' AS vpc_name,
      s.subnet_id,
      s.cidr_block AS subnet_cidr,
      s.availability_zone,
      s.tags ->> 'Name' AS subnet_name
    FROM aws_vpc v
    LEFT JOIN aws_vpc_subnet s ON v.vpc_id = s.vpc_id
    ORDER BY v.vpc_id, s.availability_zone
  `,

  // ELB -> VPC, SGs
  elbRelations: `
    SELECT
      account_id,
      name AS elb_name,
      arn,
      type,
      scheme,
      vpc_id,
      dns_name,
      availability_zones,
      security_groups
    FROM aws_ec2_application_load_balancer
    UNION ALL
    SELECT
      account_id,
      name AS elb_name,
      arn,
      type,
      scheme,
      vpc_id,
      dns_name,
      availability_zones,
      security_groups
    FROM aws_ec2_network_load_balancer
  `,

  // NAT GW -> VPC, Subnet
  natRelations: `
    SELECT account_id, nat_gateway_id, vpc_id, subnet_id, state,
      tags ->> 'Name' AS name
    FROM aws_vpc_nat_gateway
  `,

  // IGW -> VPC
  igwRelations: `
    SELECT
      account_id,
      internet_gateway_id,
      jsonb_array_elements(attachments) ->> 'VpcId' AS vpc_id,
      tags ->> 'Name' AS name
    FROM aws_vpc_internet_gateway
  `,

  // TGW -> Attachments
  tgwRelations: `
    SELECT
      account_id,
      transit_gateway_attachment_id,
      transit_gateway_id,
      resource_id,
      resource_type,
      state,
      tags ->> 'Name' AS name
    FROM aws_ec2_transit_gateway_vpc_attachment
  `,

  // RDS -> VPC, Subnet Group
  rdsRelations: `
    SELECT
      account_id,
      db_instance_identifier,
      engine,
      class AS db_instance_class,
      vpc_id,
      availability_zone,
      endpoint_address
    FROM aws_rds_db_instance
  `,

  // EKS nodes -> instances
  eksNodes: `
    SELECT name, namespace, pod_ip, node_name, phase
    FROM kubernetes_pod
    WHERE phase = 'Running'
    ORDER BY node_name, namespace
    LIMIT 200
  `,

  // K8s Services / K8s 서비스
  k8sServices: `
    SELECT
      name, namespace, type, cluster_ip,
      selector::text AS selector
    FROM kubernetes_service
    ORDER BY namespace, name
  `,

  // K8s Ingress / K8s 인그레스
  k8sIngress: `
    SELECT
      name, namespace,
      ingress_class_name,
      rules::text AS rules,
      status_load_balancer::text AS load_balancer
    FROM kubernetes_ingress
    ORDER BY namespace, name
  `,
};
