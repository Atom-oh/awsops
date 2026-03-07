"""AWS IAM MCP Lambda - Users, Roles, Groups, Policies, Access Keys, Policy Simulation"""
import json
import boto3


def lambda_handler(event, context):
    params = event if isinstance(event, dict) else json.loads(event)
    t = params.get("tool_name", "")
    args = params.get("arguments", params)

    if not t:
        if "user_name" in params and "policy" in str(params).lower(): t = "list_user_policies"
        elif "user_name" in params: t = "get_user"
        elif "role_name" in params and "policy" in str(params).lower(): t = "list_role_policies"
        elif "role_name" in params: t = "get_role_details"
        elif "group_name" in params: t = "get_group"
        elif "action_names" in params: t = "simulate_principal_policy"
        elif "policy" in str(params).lower(): t = "list_policies"
        elif "role" in str(params).lower(): t = "list_roles"
        elif "group" in str(params).lower(): t = "list_groups"
        else: t = "list_users"
        args = params

    try:
        iam = boto3.client('iam')

        # ========== Users ==========
        if t == "list_users":
            kwargs = {"MaxItems": args.get("max_items", 50)}
            if args.get("path_prefix"): kwargs["PathPrefix"] = args["path_prefix"]
            users = iam.list_users(**kwargs).get("Users", [])
            return ok({"users": [{"userName": u["UserName"], "userId": u["UserId"],
                "arn": u["Arn"], "createDate": str(u.get("CreateDate", "")),
                "passwordLastUsed": str(u.get("PasswordLastUsed", "never"))}
                for u in users]})

        elif t == "get_user":
            un = args["user_name"]
            user = iam.get_user(UserName=un)["User"]
            managed = iam.list_attached_user_policies(UserName=un).get("AttachedPolicies", [])
            inline = iam.list_user_policies(UserName=un).get("PolicyNames", [])
            groups = iam.list_groups_for_user(UserName=un).get("Groups", [])
            keys = iam.list_access_keys(UserName=un).get("AccessKeyMetadata", [])
            mfa = iam.list_mfa_devices(UserName=un).get("MFADevices", [])
            return ok({"user": {"name": user["UserName"], "arn": user["Arn"],
                "createDate": str(user.get("CreateDate", "")),
                "passwordLastUsed": str(user.get("PasswordLastUsed", "never"))},
                "managedPolicies": [p["PolicyArn"] for p in managed],
                "inlinePolicies": inline,
                "groups": [g["GroupName"] for g in groups],
                "accessKeys": [{"id": k["AccessKeyId"], "status": k["Status"],
                    "createDate": str(k.get("CreateDate", ""))} for k in keys],
                "mfaDevices": len(mfa), "mfaEnabled": len(mfa) > 0})

        # ========== Roles ==========
        elif t == "list_roles":
            kwargs = {"MaxItems": args.get("max_items", 50)}
            if args.get("path_prefix"): kwargs["PathPrefix"] = args["path_prefix"]
            roles = iam.list_roles(**kwargs).get("Roles", [])
            return ok({"roles": [{"roleName": r["RoleName"], "arn": r["Arn"],
                "createDate": str(r.get("CreateDate", "")),
                "description": r.get("Description", "")[:100],
                "maxSessionDuration": r.get("MaxSessionDuration", 3600)}
                for r in roles]})

        elif t == "get_role_details":
            rn = args["role_name"]
            role = iam.get_role(RoleName=rn)["Role"]
            managed = iam.list_attached_role_policies(RoleName=rn).get("AttachedPolicies", [])
            inline = iam.list_role_policies(RoleName=rn).get("PolicyNames", [])
            return ok({"role": {"name": role["RoleName"], "arn": role["Arn"],
                "createDate": str(role.get("CreateDate", "")),
                "description": role.get("Description", ""),
                "maxSessionDuration": role.get("MaxSessionDuration", 3600)},
                "trustPolicy": role.get("AssumeRolePolicyDocument", {}),
                "managedPolicies": [p["PolicyArn"] for p in managed],
                "inlinePolicies": inline})

        elif t == "list_role_policies":
            rn = args["role_name"]
            inline = iam.list_role_policies(RoleName=rn).get("PolicyNames", [])
            policies = []
            for pn in inline[:10]:
                doc = iam.get_role_policy(RoleName=rn, PolicyName=pn)
                policies.append({"name": pn, "document": doc.get("PolicyDocument", {})})
            return ok({"roleName": rn, "inlinePolicies": policies})

        # ========== Groups ==========
        elif t == "list_groups":
            kwargs = {"MaxItems": args.get("max_items", 50)}
            if args.get("path_prefix"): kwargs["PathPrefix"] = args["path_prefix"]
            groups = iam.list_groups(**kwargs).get("Groups", [])
            return ok({"groups": [{"name": g["GroupName"], "arn": g["Arn"],
                "createDate": str(g.get("CreateDate", ""))} for g in groups]})

        elif t == "get_group":
            gn = args["group_name"]
            resp = iam.get_group(GroupName=gn)
            members = [u["UserName"] for u in resp.get("Users", [])]
            managed = iam.list_attached_group_policies(GroupName=gn).get("AttachedPolicies", [])
            inline = iam.list_group_policies(GroupName=gn).get("PolicyNames", [])
            return ok({"group": gn, "members": members,
                "managedPolicies": [p["PolicyArn"] for p in managed],
                "inlinePolicies": inline})

        # ========== Policies ==========
        elif t == "list_policies":
            scope = args.get("scope", "Local")
            kwargs = {"Scope": scope, "MaxItems": args.get("max_items", 50),
                "OnlyAttached": args.get("only_attached", False)}
            if args.get("path_prefix"): kwargs["PathPrefix"] = args["path_prefix"]
            policies = iam.list_policies(**kwargs).get("Policies", [])
            return ok({"policies": [{"name": p["PolicyName"], "arn": p["Arn"],
                "attachmentCount": p.get("AttachmentCount", 0),
                "isAttachable": p.get("IsAttachable", True),
                "createDate": str(p.get("CreateDate", ""))} for p in policies]})

        elif t == "list_user_policies":
            un = args["user_name"]
            inline = iam.list_user_policies(UserName=un).get("PolicyNames", [])
            managed = iam.list_attached_user_policies(UserName=un).get("AttachedPolicies", [])
            return ok({"userName": un, "inlinePolicies": inline,
                "managedPolicies": [p["PolicyArn"] for p in managed]})

        elif t == "get_user_policy":
            doc = iam.get_user_policy(UserName=args["user_name"], PolicyName=args["policy_name"])
            return ok({"userName": args["user_name"], "policyName": args["policy_name"],
                "document": doc.get("PolicyDocument", {})})

        elif t == "get_role_policy":
            doc = iam.get_role_policy(RoleName=args["role_name"], PolicyName=args["policy_name"])
            return ok({"roleName": args["role_name"], "policyName": args["policy_name"],
                "document": doc.get("PolicyDocument", {})})

        # ========== Security Analysis ==========
        elif t == "simulate_principal_policy":
            kwargs = {"PolicySourceArn": args["policy_source_arn"],
                "ActionNames": args["action_names"] if isinstance(args["action_names"], list) else [args["action_names"]]}
            if args.get("resource_arns"): kwargs["ResourceArns"] = args["resource_arns"]
            resp = iam.simulate_principal_policy(**kwargs)
            results = [{"action": r["EvalActionName"], "decision": r["EvalDecision"],
                "resource": r.get("EvalResourceName", "*"),
                "matchedStatements": len(r.get("MatchedStatements", []))}
                for r in resp.get("EvaluationResults", [])]
            return ok({"simulationResults": results})

        # ========== Access Keys ==========
        elif t == "list_access_keys":
            un = args.get("user_name", "")
            keys = iam.list_access_keys(UserName=un).get("AccessKeyMetadata", [])
            result = []
            for k in keys:
                last_used = iam.get_access_key_last_used(AccessKeyId=k["AccessKeyId"])
                lu = last_used.get("AccessKeyLastUsed", {})
                result.append({"id": k["AccessKeyId"], "status": k["Status"],
                    "createDate": str(k.get("CreateDate", "")),
                    "lastUsed": str(lu.get("LastUsedDate", "never")),
                    "lastService": lu.get("ServiceName", ""),
                    "lastRegion": lu.get("Region", "")})
            return ok({"userName": un, "accessKeys": result})

        # ========== Security Overview ==========
        elif t == "get_account_security_summary":
            summary = iam.get_account_summary()["SummaryMap"]
            cred_report = None
            try:
                iam.generate_credential_report()
            except:
                pass
            return ok({"summary": {
                "users": summary.get("Users", 0),
                "roles": summary.get("Roles", 0),
                "groups": summary.get("Groups", 0),
                "policies": summary.get("Policies", 0),
                "mfaDevicesInUse": summary.get("MFADevicesInUse", 0),
                "accessKeysPerUserQuota": summary.get("AccessKeysPerUserQuota", 0),
                "accountMFAEnabled": summary.get("AccountMFAEnabled", 0),
                "serverCertificates": summary.get("ServerCertificates", 0)}})

        return err("Unknown tool: " + t)

    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}


def ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str)}

def err(msg):
    return {"statusCode": 400, "body": json.dumps({"error": msg})}
