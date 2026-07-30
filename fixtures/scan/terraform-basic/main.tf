resource "aws_security_group" "app_sg" {
  name = "app-sg"
  # unrecognized resource type — must be skipped, not become a node
}

resource "aws_db_instance" "orders_db" {
  engine         = "postgres"
  instance_class = "db.t3.micro"
}

resource "aws_sqs_queue" "orders_queue" {
  name = "orders-queue"
}

resource "aws_ecs_service" "api" {
  name = "api"

  environment {
    DB_HOST   = aws_db_instance.orders_db.address
    QUEUE_URL = aws_sqs_queue.orders_queue.url
  }
}
