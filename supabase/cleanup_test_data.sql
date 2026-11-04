-- Removes everything seed_test_data.sql created (only @test.swarkatha users).
delete from trial_claims where email_normalized like '%@test.swarkatha';
delete from app_users    where email like '%@test.swarkatha';   -- cascades subscriptions, history, devices
