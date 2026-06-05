FROM turbot/steampipe:0.24.2
# pinned plugin for deterministic schema; aws.spc = default cred chain (Fargate task role)
RUN steampipe plugin install aws@1.7.0
COPY --chown=steampipe:0 aws.spc /home/steampipe/.steampipe/config/aws.spc
EXPOSE 9193
# network listener so the in-VPC sync Lambda can reach it; password via env STEAMPIPE_DATABASE_PASSWORD
ENTRYPOINT ["steampipe", "service", "start", "--database-listen", "network", "--database-port", "9193", "--foreground"]
