-- Pending portfolio content for Supabase.
-- Apply after connectivity is restored and verify the row before committing.
-- This queue intentionally does not modify data/*.json.
begin;
-- React, TypeScript, Angular, C++, .NET, and Docker already exist in public.skills.
-- The remaining tools are queued once here.
insert into public.skills (
    slug,
    name,
    visual,
    proficiency,
    category
  )
select queued.slug,
  queued.name,
  queued.visual,
  queued.proficiency,
  queued.category
from (
    values (
        'electron',
        'Electron',
        'https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white',
        'Experienced',
        'Other Tools'
      ),
      (
        'splunk',
        'Splunk',
        'https://img.shields.io/badge/Splunk-000000?style=for-the-badge&logo=splunk&logoColor=white',
        'Exposed',
        'DevOps'
      ),
      (
        'grafana',
        'Grafana',
        'https://img.shields.io/badge/Grafana-F46800?style=for-the-badge&logo=grafana&logoColor=white',
        'Exposed',
        'DevOps'
      ),
      (
        'ssh',
        'SSH',
        'https://img.shields.io/badge/SSH-222222?style=for-the-badge&logo=openssh&logoColor=white',
        'Exposed',
        'DevOps'
      ),
      (
        'github-copilot',
        'GitHub Copilot',
        'https://img.shields.io/badge/GitHub_Copilot-000000?style=for-the-badge&logo=githubcopilot&logoColor=white',
        'Experienced',
        'AI Tools'
      ),
      (
        'claude-code',
        'Claude Code',
        'https://img.shields.io/badge/Claude_Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white',
        'Experienced',
        'AI Tools'
      )
  ) as queued(slug, name, visual, proficiency, category)
where not exists (
    select 1
    from public.skills existing
    where existing.slug = queued.slug
  );
insert into public.experiences (
    slug,
    title,
    subtitle,
    timeframe,
    description,
    order_index
  )
select 'software-engineer-tools-ea',
  'Software Engineer',
  'Electronic Arts (EA) · AFL Tools · Orlando, FL · Hybrid',
  'Jan 2026 – Present',
  'Built and maintained developer-facing tools for EA SPORTS Madden and College Football production workflows. Scaled a React content-change management interface to support searching and navigating up to 1,000,000 changes, a 200x increase over the previous limit, through selective rendering, lazy loading, and improved state management. Replaced legacy SQL connectivity with C++, Angular, and .NET server RPC integrations to expose real-time game data, added unit-test coverage, and supported five microservices through SSH/Docker, Splunk, and Grafana. Led AI skill development across two codebases to reduce token usage for repetitive coding tasks and improve LLM context management, and built an Electron setup GUI that enabled external stakeholders to self-serve common changes.',
  0
where not exists (
    select 1
    from public.experiences
    where slug = 'software-engineer-tools-ea'
  );
insert into public.experience_skills (experience_slug, skill_slug)
select 'software-engineer-tools-ea',
  queued.skill_slug
from (
    values ('react'),
      ('typescript'),
      ('electron'),
      ('angular'),
      ('cpp'),
      ('dotnet'),
      ('docker'),
      ('splunk'),
      ('grafana'),
      ('ssh'),
      ('github-copilot'),
      ('claude-code')
  ) as queued(skill_slug)
where exists (
    select 1
    from public.experiences
    where slug = 'software-engineer-tools-ea'
  )
  and exists (
    select 1
    from public.skills
    where slug = queued.skill_slug
  )
  and not exists (
    select 1
    from public.experience_skills existing
    where existing.experience_slug = 'software-engineer-tools-ea'
      and existing.skill_slug = queued.skill_slug
  );
commit;