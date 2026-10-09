-- Invitations become either email-bound single-use invites or reusable share links.
ALTER TABLE invitations ADD COLUMN kind text NOT NULL DEFAULT 'email' CHECK(kind IN ('email','link'));
ALTER TABLE invitations ADD COLUMN max_uses integer NOT NULL DEFAULT 1 CHECK(max_uses BETWEEN 1 AND 100);
ALTER TABLE invitations ADD COLUMN use_count integer NOT NULL DEFAULT 0;
ALTER TABLE invitations ADD COLUMN revoked_at timestamptz;
ALTER TABLE invitations ADD COLUMN conversation_id text;
ALTER TABLE invitations ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
UPDATE invitations SET use_count = 1 WHERE accepted_at IS NOT NULL;
UPDATE invitations SET kind = 'link' WHERE email IS NULL;
ALTER TABLE invitations ADD CONSTRAINT invitations_uses CHECK(use_count <= max_uses);

CREATE TABLE invitation_acceptances (
 invitation_id text NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 accepted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(invitation_id,user_id)
);

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN
 ('mention','approval_request','critical_finding','run_completed','run_failed','drift_detected','member_joined'));
