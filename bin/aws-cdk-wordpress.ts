#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { AwsCdkWordpressStack } from '../lib/aws-cdk-wordpress-stack';

const app = new App();
new AwsCdkWordpressStack(app, 'AwsCdkWordpressStack', {

  //env: { 
  //  account: '123456789012', region: 'ap-southeast-2' 
  //},
  //route53domain: '',
  //SetRoute53RootURL: true,
  //wordpressFQDN: '',
  //VpcCidr: '',
 // privateECR: '',


  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});
