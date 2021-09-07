import { Construct } from "constructs"; 
import { Duration, aws_iam as iam, aws_rds as rds, aws_secretsmanager as secretsmanager, aws_certificatemanager as certificatemanager, aws_route53 as route53, aws_elasticloadbalancingv2 as elbv2, aws_elasticloadbalancingv2_targets as targets, aws_ec2 as ec2, aws_ecs as ecs, aws_efs as efs, Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { FargateService } from "aws-cdk-lib/lib/aws-ecs";
import { FargateCluster } from "aws-cdk-lib/lib/aws-eks";


export interface CdkWordPressStackProps extends StackProps {

  readonly VpcCidr?: string;
  readonly CertificateArn?: string; //ARN for AWS Certificate Manager SSL Certificate
  readonly auroramaxUnit?: string; //RDS Instance type
  readonly route53domain?: string; //Route 53 Hosted Domain (Optional). If specified ACM will use for Certificate and create HTTPS listener for Load Balancer
  readonly wordpressFQDN?: string;

}

export class AwsCdkWordpressStack extends Stack {
  constructor(scope: Construct, id: string, props?: CdkWordPressStackProps) {
    super(scope, id, props);

    /*1. Create Network Infrastructure to be consumed by Fargate Cluster
    
    - VPC
    - Load Balancer
    - Security Group
    */

    // Create VPC (/24)
    const vpc=new ec2.Vpc(this,"wordpressVpc",{
    cidr: '192.168.0.0/24',
    maxAzs: 2,
   
    subnetConfiguration: [
      {
        name: 'Application',
        cidrMask: 26,
        subnetType: ec2.SubnetType.ISOLATED,
        
        
        },
  
    {
    name: 'Public',
    cidrMask: 27,
    subnetType: ec2.SubnetType.PUBLIC
    
    },
      {
        name: 'Data',
        cidrMask: 28,
        subnetType: ec2.SubnetType.ISOLATED
        
        
      },
    
    ]
    
    });

    //#########################################################################
    //# Section: VPC Endpoints                                                #
    //#
    //# Using ECR without NAT Gateway requires 3 Endpoints configured (2 Interface Endpoints and 1 Gateway Endpoint)
    //#########################################################################

    const appsubnets = vpc.selectSubnets({
      subnetGroupName:  "Application",
      onePerAz: true,
    });

    // Adding interface endpoints for ECR Api
    const ecrIE = vpc.addInterfaceEndpoint('ECR', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      privateDnsEnabled: true,
      subnets: appsubnets,
    });
    ecrIE.connections.allowFrom(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443), 'Allow from ECR IE Private SG');

// Adding interface endpoints for ECR Docker (Required for Fargate 1.4.0 or later)
    const ecrdkrIE = vpc.addInterfaceEndpoint('ECR-Docker', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      privateDnsEnabled: true,
      subnets: appsubnets,
    });
    ecrdkrIE.connections.allowFrom(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443), 'Allow from ECR IE Private SG');
    

    vpc.addGatewayEndpoint('S3-GWEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [appsubnets],
    });
    

    //Enable Cloudwatch Flow Logs to Cloudwatch Logs (Best Practice for VPC)
    const CloudWatchflowLog = new ec2.FlowLog(this, "flowlog-to-cloudwatch", {
      resourceType: ec2.FlowLogResourceType.fromVpc(vpc),
    })

    CloudWatchflowLog.node.children.forEach(c => {
      let fl = c.node.defaultChild as ec2.CfnFlowLog
      if (fl) {
        fl.logGroupName = "/aws/vpc/" + vpc.vpcId + "/"
      }
    });
    


    //Create an Application Load Balancer for use with the Container
    //HTTPS Listener is only created automatically with a Route 53 hosted DNS Zone

    const lb=new elbv2.ApplicationLoadBalancer(this, 'WordpressLB', {
      vpc,
      internetFacing: true
    });  

    

    const targetGroupHttp = new elbv2.ApplicationTargetGroup(
      this,
      "wordpress",
      {
        port: 80,
        vpc,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
      }
    );
    
    
        targetGroupHttp.configureHealthCheck({
          path: "/api/status",
          protocol: elbv2.Protocol.HTTP,
        });
        

    let listener:elbv2.ApplicationListener
    
    if (props?.route53domain != undefined) {
      const zone = route53.HostedZone.fromLookup(this, `acmroute53zone`, {
        domainName: props?.route53domain,
      });
    
      let domainname=props.wordpressFQDN!;
      // SSL certificate for the domain 
      const cert = new certificatemanager.Certificate(this,"certificate",
        {
          domainName: domainname,
          validation: certificatemanager.CertificateValidation.fromDns(zone),
        });

        
        // only allow HTTPS connections 
        listener = lb.addListener('HTTPSListener', {
          open: true,
          port: 443,
          certificates: [cert],
          defaultTargetGroups: [targetGroupHttp]
  
       });

       lb.addRedirect({
        sourceProtocol: elbv2.ApplicationProtocol.HTTP,
        sourcePort: 80,
        targetProtocol: elbv2.ApplicationProtocol.HTTPS,
        targetPort: 443,
      });
    } else {

      //HTTP Only listener when no certificate is provided
      listener = lb.addListener('HTTPListener', {
        port: 80,
        open: true,
        defaultTargetGroups: [targetGroupHttp]
      });

    }

   


    //Target connects to Task Definition

    /*listener.addTargets('ApplicationFleet', {
      port: 8080,
      targets: [asg]
    });
*/

   // Iterate the data subnets and place into an array

   const selection = vpc.selectSubnets({
     subnetGroupName:  "Data",
     onePerAz: true,
   });

   
   //EFS Security Group
   const efssg=new ec2.SecurityGroup(this, "efs-securitygroup",{
    vpc: vpc,
    allowAllOutbound: false

  });

  //Fargate Security Group
  const fargatesg=new ec2.SecurityGroup(this, "ecs-securitygroup",{
    vpc: vpc,
    allowAllOutbound: true
    

  });

  //RDS Security Group 
  const dbSecurityGroup = new ec2.SecurityGroup(this,"securitygroupforDB", {
    allowAllOutbound: false,
    vpc: vpc
  });

  dbSecurityGroup.connections.allowFrom(fargatesg,ec2.Port.tcp(3306), 'Allow MySQL access from Fargate Service');
  efssg.connections.allowFrom(fargatesg, ec2.Port.tcp(2049), 'allow EFS connectivity from Fargate')
  

  //Allow Load Balancer to communicate with Fargate Container
  fargatesg.connections.allowFrom(lb, ec2.Port.tcp(8080), 'Allow from Load Balancer to ECS');

    //Wordpress in a Container needs a persistent storage so an EFS volume is created for this purpose and mounted
    const efsvolume=new efs.FileSystem(this, 'WordPressEfsFileSystem', {
      vpc: vpc, //associate with existing vpc
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS, // files are not transitioned to infrequent access (IA) storage by default
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE, // default
      removalPolicy: RemovalPolicy.SNAPSHOT,
      vpcSubnets:selection,
      securityGroup:efssg
    });

 


     // Iterate the data subnets and place into an array
     let appsubnetids: Array<string>= [];
     const appselection = vpc.selectSubnets({
       subnetGroupName:  "Application",
       onePerAz: true,
     });

    for (const appsubnet of appselection.subnets) {
       appsubnetids.push(appsubnet.subnetId).toString;
    }


    /*Create Aurora Serverless environment
    */

  // Default secret
  const dbpassword = new secretsmanager.Secret(this, 'dbpassword',{
    secretName: 'auroraSecret',
    
    generateSecretString: {
      excludePunctuation: true,
      includeSpace: false,
      secretStringTemplate: JSON.stringify({ username: 'wordpressadmin' }),
      generateStringKey: 'password'
    }

  }
  );
  

    const auroraDatabaseCluster = new rds.ServerlessCluster(this, 'Database', {
      engine: rds.DatabaseClusterEngine.AURORA_MYSQL,
      credentials: rds.Credentials.fromSecret(dbpassword),
      parameterGroup:  rds.ParameterGroup.fromParameterGroupName(this, 'ParameterGroup', 'default.aurora-mysql5.7'),
      defaultDatabaseName: 'wordpress',
      vpc: vpc,
      securityGroups: [dbSecurityGroup],
      //storageEncryptionKey: databaseKey,
      deletionProtection: false
    });

    /*Create Fargate Service, Task and components
    */
 
    // Create the IAM role assumed by the task and its containers
          const taskRole = new iam.Role(this, "wordpresstask-role", {
            assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
            roleName: "task-role",
            description: "Role that the api task definitions use to run the api code",
          });
    
          taskRole.attachInlinePolicy(
            new iam.Policy(this, "efs-access-policy", {
              statements: [
                // policies to allow access to other AWS services from within the container e.g SES (Simple Email Service)
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  actions: [
                    "elasticfilesystem:*",
                    
                ],
                  resources: [efsvolume.fileSystemArn],
                }),
              ],
            })
          );
    
          taskRole.attachInlinePolicy(
            new iam.Policy(this, "ecs-access-policy", {
              statements: [
                // policies to allow access to other AWS services from within the container e.g SES (Simple Email Service)
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  actions: [
                    "ecr:GetAuthorizationToken",
                    "ecr:BatchCheckLayerAvailability",
                    "ecr:GetDownloadUrlForLayer",
                    "ecr:BatchGetImage",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents"
                    
                ],
                  resources: ["*"],
                }),
              ],
            })
          );
    //Create Fargate Environment (ECS Cluster, Definitions, Service, etc.)

   
  
    
    

    const fargatetask=new ecs.FargateTaskDefinition(this, "fargatetask", {
    
    family: "wordpress",   
    memoryLimitMiB: 2048,
    cpu: 256,
    taskRole: taskRole,
    executionRole: taskRole,
    volumes: [{
      efsVolumeConfiguration: {
        fileSystemId: efsvolume.fileSystemId,
        transitEncryption: 'ENABLED',
        
      },
      
      name: 'wordpress-data'
      
    }],
    
   

    
    });

    
    fargatetask.addContainer('wordpress', {
      image: ecs.ContainerImage.fromRegistry("bitnami/wordpress"),
      memoryLimitMiB:512,
      portMappings: [{
        containerPort: 8080,
        protocol: ecs.Protocol.TCP
      }],
      
      logging:  ecs.LogDrivers.awsLogs ({ streamPrefix: 'WordPressLogs' }),
      environment: {
        
          //Environment variables pass from Aurora Deployment
          MARIADB_HOST: auroraDatabaseCluster.clusterEndpoint.hostname,
          WORDPRESS_DATABASE_USER: "wordpressadmin",
          WORDPRESS_DATABASE_NAME: 'wordpress',
          PHP_MEMORY_LIMIT: "512M",
          enabled: "false",
          ALLOW_EMPTY_PASSWORD:"yes"
      },
      

      secrets: {
        WORDPRESS_DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(dbpassword, 'password')

      },
  
      


    
      

    });

    

    const ecscluster=new ecs.Cluster(this, "ecscluster", {
      vpc: vpc,
      clusterName: "WordPress",
      
      });    
          



    const fargateService=new ecs.FargateService(this, "fargateservice",{
    taskDefinition: fargatetask,
    cluster: ecscluster,
    vpcSubnets: appselection,
    desiredCount:1,
    securityGroups:[fargatesg],
    serviceName: 'wordpress'

    });

    fargateService.attachToApplicationTargetGroup(targetGroupHttp);

 
}

}