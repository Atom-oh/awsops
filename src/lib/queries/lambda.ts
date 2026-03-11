export const queries = {
  summary: `
    SELECT
      COUNT(*) AS total_functions,
      COALESCE(SUM(code_size), 0) AS total_code_size_bytes,
      COUNT(DISTINCT runtime) AS unique_runtimes,
      COUNT(*) FILTER (WHERE timeout::int > 300) AS long_timeout_functions
    FROM
      aws_lambda_function
  `,

  runtimeDistribution: `
    SELECT
      COALESCE(runtime, 'custom') AS name,
      COUNT(*) AS value
    FROM
      aws_lambda_function
    GROUP BY
      runtime
    ORDER BY
      value DESC
  `,

  detail: `
    SELECT
      name,
      arn,
      description,
      runtime,
      handler,
      code_size,
      code_sha_256,
      last_modified,
      memory_size,
      timeout,
      version,
      state,
      last_update_status,
      package_type,
      architectures::text AS architectures,
      layers::text AS layers,
      vpc_config::text AS vpc_config,
      region
    FROM
      aws_lambda_function
    WHERE
      name = '{name}'
  `,

  list: `
    SELECT
      name,
      runtime,
      handler,
      memory_size,
      timeout,
      code_size,
      last_modified,
      region
    FROM
      aws_lambda_function
    ORDER BY
      last_modified DESC
  `
};
